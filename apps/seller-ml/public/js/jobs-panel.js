// =============================================================
// Base path helper (supports deployments under /ml)
// =============================================================
(function initBasePath(){
  if (typeof window === 'undefined') return;
  if (window.__ML_BASE_PATH != null) return;
  const p = window.location && window.location.pathname ? window.location.pathname : '';
  window.__ML_BASE_PATH = (p === '/ml' || p.startsWith('/ml/')) ? '/ml' : '';
})();

function withBase(path) {
  const base = (typeof window !== 'undefined' && window.__ML_BASE_PATH) ? window.__ML_BASE_PATH : '';
  if (!path || typeof path !== 'string') return path;
  if (!base) return path;
  if (path === base || path.startsWith(base + '/')) return path;
  if (path.startsWith('/')) return base + path;
  return path;
}

// public/js/jobs-panel.js
// Painel fixo de processos (lado direito embaixo), usado pela Central de Promoções
// API exposta em window.JobsPanel:
//   - addLocalJob({ title, accountKey?, accountLabel? }) -> jobId
//   - updateLocalJob(jobId, { progress?, state?, completed?, accountKey?, accountLabel? })
//   - mergeApiJobs(list)  // integra com JobsWatcher (criar-promocao.js / pesquisa descrição / exclusão etc.)
//   - replaceId(oldId, newId)  // troca o id de um job já exibido para outro (ex: id temporário -> process_id do backend)
//   - show()
//   - hide()

(function () {
  const PANEL_ID = "bulkJobsPanel";
  const $ = (s) => document.querySelector(s);

  // { id, title, progress, state, completed, locked, accountKey, accountLabel, dismissed, updated, sortOrder, completedAt }
  let jobs = [];
  let nextSortOrder = 1;
  let panelEl = null;
  let collapsed = false;
  let panelHidden = false;
  let cancelHandler = null;
  let visibilityFilter = null;
  let panelScrollTop = 0;
  let searchQuery = "";
  let defaultAdapter = "generic";
  const preparingDownloads = new Set();
  const activeApiWatchers = new Set();
  const dismissedJobIds = new Set();
  const DISMISSED_STORAGE_KEY = "ml.jobsPanel.dismissed.v2";
  const JOBS_STORAGE_KEY = "ml.jobsPanel.items.v3";
  const LEGACY_JOBS_STORAGE_KEYS = [
    "ml.jobsPanel.items.v1",
    "ml.jobsPanel.items.v2",
  ];
  const MAX_VISIBLE_JOBS = 10;
  const MAX_STORED_JOBS = 80;
  const RECENT_COMPLETED_MS = 24 * 60 * 60 * 1000;
  const RECENT_FAILED_MS = 3 * 24 * 60 * 60 * 1000;
  const DISMISSED_TTL_MS = RECENT_FAILED_MS;
  let persistTimer = null;

  function canUseStorage() {
    try {
      return typeof window !== "undefined" && !!window.localStorage;
    } catch {
      return false;
    }
  }

  function readDismissedJobs() {
    if (!canUseStorage()) return {};
    try {
      const raw = window.localStorage.getItem(DISMISSED_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeDismissedJobs(store) {
    if (!canUseStorage()) return;
    try {
      window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(store));
    } catch {}
  }

  function pruneDismissedJobs(store) {
    const source = store && typeof store === "object" ? store : readDismissedJobs();
    const now = Date.now();
    const next = {};

    Object.entries(source).forEach(([jobId, ts]) => {
      const savedAt = Number(ts);
      if (!jobId || !Number.isFinite(savedAt)) return;
      if (now - savedAt > DISMISSED_TTL_MS) return;
      next[jobId] = savedAt;
    });

    return next;
  }

  function loadDismissedJobs() {
    const store = pruneDismissedJobs();
    Object.keys(store).forEach((jobId) => dismissedJobIds.add(jobId));
    writeDismissedJobs(store);
  }

  function persistDismissedJobId(id) {
    const key = String(id || "").trim();
    if (!key) return;
    const store = pruneDismissedJobs();
    store[key] = Date.now();
    writeDismissedJobs(store);
  }

  function forgetDismissedJobId(id) {
    const key = String(id || "").trim();
    if (!key) return;
    const store = pruneDismissedJobs();
    if (!Object.prototype.hasOwnProperty.call(store, key)) return;
    delete store[key];
    writeDismissedJobs(store);
  }

  function sanitizeReviewAction(action) {
    if (!action || typeof action !== "object") return null;
    const url = String(action.url || "").trim();
    if (!url) return null;
    return {
      label: String(action.label || "Baixar CSV"),
      url,
      filename: String(action.filename || "").trim() || null,
    };
  }

  function shouldKeepStoredJob(job, now = Date.now()) {
    if (!job || !job.id || job.dismissed) return false;
    // Active jobs are always rebuilt from the owning API after a reload.
    // Persisting them was the main source of stale cards stuck at 100%.
    if (!job.completed) return false;
    const updated = Number(job.updated || 0);
    const ageMs = updated > 0 ? Math.max(0, now - updated) : Number.POSITIVE_INFINITY;
    if (isTerminalFailed(job.state)) return ageMs <= RECENT_FAILED_MS;
    return ageMs <= RECENT_COMPLETED_MS;
  }

  function snapshotJob(job) {
    return {
      id: String(job.id || ""),
      title: String(job.title || "Processo"),
      progress: clamp(job.progress),
      state: normalizeStateText(job.state || ""),
      completed: !!job.completed,
      locked: !!job.locked,
      dismissed: !!job.dismissed,
      accountKey: job.accountKey || null,
      accountLabel: job.accountLabel || null,
      updated: Number(job.updated || Date.now()),
      sortOrder: Number(job.sortOrder || 0),
      completedAt: Number(job.completedAt || 0),
      processed:
        Number.isFinite(Number(job.processed)) ? Number(job.processed) : undefined,
      success: Number.isFinite(Number(job.success)) ? Number(job.success) : undefined,
      total: Number.isFinite(Number(job.total)) ? Number(job.total) : undefined,
      errors: Number.isFinite(Number(job.errors)) ? Number(job.errors) : undefined,
      error: job.error || job.failedReason || null,
      failedReason: job.failedReason || job.error || null,
      reviewAction: sanitizeReviewAction(job.reviewAction),
      adapter: String(job.adapter || "generic"),
      backendJobId: String(job.backendJobId || ""),
      source: "stored",
    };
  }

  function migrateLegacyStoredJobs() {
    if (!canUseStorage()) return;
    try {
      // V1 did not namespace ids, so even completed records can collide.
      // Drop it instead of carrying ambiguous identities into the new contract.
      LEGACY_JOBS_STORAGE_KEYS.forEach((key) => window.localStorage.removeItem(key));
    } catch {
      LEGACY_JOBS_STORAGE_KEYS.forEach((key) => {
        try { window.localStorage.removeItem(key); } catch {}
      });
    }
  }

  function readStoredJobs() {
    if (!canUseStorage()) return [];
    try {
      const raw = window.localStorage.getItem(JOBS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed?.jobs)
        ? parsed.jobs
        : Array.isArray(parsed)
          ? parsed
          : [];
      return list.filter((entry) => entry && typeof entry === "object");
    } catch {
      return [];
    }
  }

  function writeStoredJobs(list) {
    if (!canUseStorage()) return;
    try {
      window.localStorage.setItem(
        JOBS_STORAGE_KEY,
        JSON.stringify({ saved_at: Date.now(), jobs: list }),
      );
    } catch {}
  }

  function schedulePersistJobs() {
    if (!canUseStorage()) return;
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const now = Date.now();
      const snapshot = jobs
        .filter((job) => shouldKeepStoredJob(job, now))
        .sort(compareJobs)
        .slice(0, MAX_STORED_JOBS)
        .map(snapshotJob);
      writeStoredJobs(snapshot);
    }, 120);
  }

  function loadJobsFromStorage() {
    migrateLegacyStoredJobs();
    const now = Date.now();
    const restored = readStoredJobs()
      .map((raw) => {
        const id = String(raw?.id || "").trim();
        if (!id || dismissedJobIds.has(id) || raw.completed !== true) return null;

        const job = {
          id,
          title: String(raw.title || "Processo"),
          progress: clamp(raw.progress),
          state: normalizeStateText(raw.state || "iniciando..."),
          completed: !!raw.completed,
          locked: !!raw.locked,
          dismissed: !!raw.dismissed,
          accountKey: raw.accountKey || null,
          accountLabel: raw.accountLabel || null,
          updated: normalizeTimestamp(raw.updated, now),
          sortOrder: Number(raw.sortOrder || 0) || 0,
          completedAt: normalizeTimestamp(raw.completedAt, 0),
          reviewAction: sanitizeReviewAction(raw.reviewAction),
          adapter: String(raw.adapter || "generic"),
          backendJobId: String(raw.backendJobId || raw.id || ""),
          source: "stored",
        };

        if (Number.isFinite(Number(raw.processed))) job.processed = Number(raw.processed);
        if (Number.isFinite(Number(raw.success))) job.success = Number(raw.success);
        if (Number.isFinite(Number(raw.total))) job.total = Number(raw.total);
        if (Number.isFinite(Number(raw.errors))) job.errors = Number(raw.errors);

        // Estado terminal nao significa que 100% do lote foi processado.
        // Preserve a cobertura real quando processed/total estiverem disponiveis.
        if (!shouldKeepStoredJob(job, now)) return null;
        return job;
      })
      .filter(Boolean)
      .sort(compareJobs);

    if (!restored.length) return;
    jobs = restored;
    nextSortOrder =
      Math.max(
        nextSortOrder,
        ...restored.map((job) => Number(job.sortOrder || 0)),
      ) + 1;
  }

  function normalizeScopeToken(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    return raw
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/^\s*conta\s+/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isPlaceholderAccountLabel(value) {
    const token = normalizeScopeToken(value);
    return (
      !token ||
      token === "conta" ||
      token === "carregando" ||
      token === "indisponivel" ||
      token === "nao selecionada" ||
      token === "nenhuma selecionada" ||
      token === "desconhecida"
    );
  }

  function readActiveAccountLabel() {
    if (typeof document === "undefined") return null;
    const raw = String(document.getElementById("account-current")?.textContent || "").trim();
    if (!raw || isPlaceholderAccountLabel(raw)) return null;
    return raw.replace(/^\s*conta\s+/i, "").trim();
  }

  function collectScopeTokens(...values) {
    const tokens = new Set();
    values.flat().forEach((value) => {
      const token = normalizeScopeToken(value);
      if (token) tokens.add(token);
    });
    return Array.from(tokens);
  }

  function getActiveAccountDisplayScope() {
    const account =
      typeof window !== "undefined" && window.__ACCOUNT__ && typeof window.__ACCOUNT__ === "object"
        ? window.__ACCOUNT__
        : {};
    const rawKey =
      account.key ??
      account.accountKey ??
      account.meli_conta_id ??
      account.meliContaId ??
      null;
    const rawLabel = readActiveAccountLabel() || account.label || null;
    return {
      key: rawKey != null && String(rawKey).trim() ? String(rawKey).trim() : null,
      label: rawLabel != null && String(rawLabel).trim() ? String(rawLabel).trim() : null,
    };
  }

  function getActiveAccountTokens() {
    const account =
      typeof window !== "undefined" && window.__ACCOUNT__ && typeof window.__ACCOUNT__ === "object"
        ? window.__ACCOUNT__
        : {};
    return collectScopeTokens(
      account.key,
      account.accountKey,
      account.meli_conta_id,
      account.meliContaId,
      readActiveAccountLabel(),
      account.label,
    );
  }

  function getJobAccountTokens(job) {
    return collectScopeTokens(
      job?.accountKey,
      job?.account?.key,
      job?.account?.meli_conta_id,
      job?.account?.meliContaId,
      job?.accountLabel,
      job?.account?.label,
    );
  }

  function matchesActiveAccount(job) {
    const activeTokens = getActiveAccountTokens();
    if (!activeTokens.length) return true;
    const jobTokens = getJobAccountTokens(job);
    if (!jobTokens.length) return true;
    return jobTokens.some((token) => activeTokens.includes(token));
  }

  function isVisibleByFilter(job) {
    if (!matchesActiveAccount(job)) return false;
    if (typeof visibilityFilter !== "function") return true;
    try {
      return visibilityFilter(job) !== false;
    } catch {
      return true;
    }
  }

  loadDismissedJobs();
  loadJobsFromStorage();

  function dismissJobId(id) {
    const key = String(id || "").trim();
    if (!key) return;
    dismissedJobIds.add(key);
    persistDismissedJobId(key);
    const job = jobs.find((x) => x.id === key);
    if (job) job.dismissed = true;
    schedulePersistJobs();
  }

  function ensurePanel() {
    if (!panelEl) panelEl = document.getElementById(PANEL_ID);
    return panelEl;
  }

  function clamp(n) {
    const v = Number(n ?? 0);
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(100, Math.round(v)));
  }

  function normalizePanelIdentity(id, adapterName = defaultAdapter, explicitBackendId = null) {
    const adapter = String(adapterName || "generic");
    const rawId = String(id || "").trim();
    const suppliedBackendId = String(explicitBackendId || "").trim();
    if (!rawId && !suppliedBackendId) return { uid: "", backendJobId: "", adapter };
    if (!window.JobsPanelAdapters?.createUid) {
      return {
        uid: rawId || suppliedBackendId,
        backendJobId: suppliedBackendId || rawId,
        adapter,
      };
    }
    const backendJobId =
      suppliedBackendId || window.JobsPanelAdapters.backendId(adapter, rawId);
    return {
      uid: window.JobsPanelAdapters.createUid(adapter, backendJobId),
      backendJobId,
      adapter,
    };
  }

  function normalizeTimestamp(value, fallback = 0) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const asNumber = Number(value);
      if (Number.isFinite(asNumber)) return asNumber;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
  }

  function compareJobs(a, b) {
    const aCompleted = a?.completed ? 1 : 0;
    const bCompleted = b?.completed ? 1 : 0;
    if (aCompleted !== bCompleted) return aCompleted - bCompleted;

    if (!aCompleted && !bCompleted) {
      const aOrder = Number(a?.sortOrder || 0);
      const bOrder = Number(b?.sortOrder || 0);
      if (bOrder !== aOrder) return bOrder - aOrder;
    }

    if (aCompleted && bCompleted) {
      const aCompletedAt = Number(a?.completedAt || a?.updated || 0);
      const bCompletedAt = Number(b?.completedAt || b?.updated || 0);
      if (bCompletedAt !== aCompletedAt) return bCompletedAt - aCompletedAt;
    }

    const aUpdated = Number(a?.updated || 0);
    const bUpdated = Number(b?.updated || 0);
    if (bUpdated !== aUpdated) return bUpdated - aUpdated;

    return String(a?.id || "").localeCompare(String(b?.id || ""));
  }

  function esc(s) {
    return s == null
      ? ""
      : String(s).replace(
          /[&<>"']/g,
          (c) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            }[c])
        );
  }

  function normalizeStateText(s) {
    const t = String(s || "").trim();
    if (!t) return "";
    return t.replace(/\s+/g, " ");
  }

  function toTitleCase(text) {
    const t = String(text || "").trim();
    if (!t) return "";
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  function formatCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "";
    return Math.round(n).toLocaleString("pt-BR");
  }

  function formatProgressBits(processed, total, progress) {
    const hasCounts =
      Number.isFinite(processed) && Number.isFinite(total) && total > 0;
    const hasProgress = Number.isFinite(progress) && progress >= 0;
    if (hasCounts && hasProgress) {
      return `${formatCount(processed)}/${formatCount(total)} - ${progress}%`;
    }
    if (hasCounts) return `${formatCount(processed)}/${formatCount(total)}`;
    if (hasProgress) return `${progress}%`;
    return "";
  }

  function humanizeState(stateText, progress, processed, total, errors) {
    const raw = normalizeStateText(stateText);
    const lower = raw.toLowerCase();
    const bits = formatProgressBits(processed, total, progress);

    if (!raw) return bits ? `Processando ${bits}` : "Iniciando...";

    if (/^(paused_safety|pausado por seguranca|pausado por segurança)\b/i.test(lower)) {
      return bits ? `Pausado por seguranca • ${bits}` : "Pausado por seguranca";
    }

    if (/^(retry_wait|aguardando retomada automatica|aguardando retomada automática)\b/i.test(lower)) {
      return bits ? `Aguardando retomada automatica • ${bits}` : "Aguardando retomada automatica";
    }

    if (/^(review_pending|em revisao|em revisão|revisao pendente|revisão pendente)\b/i.test(lower)) {
      return bits ? `Em revisao • ${bits}` : "Em revisao";
    }

    if (/^(queued|queue|pending|waiting|scheduled|agendado|na fila|aguardando)\b/i.test(lower)) {
      return bits ? `Na fila ${bits}` : "Na fila";
    }

    if (/^(active|running|processing|processando|iniciando)\b/i.test(lower)) {
      return bits ? `Processando ${bits}` : "Processando";
    }

    if (/^obtendo anuncios da conta\b/i.test(lower)) {
      return bits ? `Obtendo anuncios da conta ${bits}` : "Obtendo anuncios da conta";
    }

    if (/^obtendo dados dos anuncios\b/i.test(lower)) {
      return bits ? `Obtendo dados dos anuncios ${bits}` : "Obtendo dados dos anuncios";
    }

    if (/^(cancelando)\b/i.test(lower)) {
      return bits ? `Cancelando ${bits}` : "Cancelando";
    }

    if (/^(cancelado|cancelled|canceled|abortado|aborted)\b/i.test(lower)) {
      return "Cancelado";
    }

    if (/^erro ao iniciar\b/i.test(lower)) {
      const detail = raw.split(":").slice(1).join(":").trim();
      return detail ? `Falha ao iniciar: ${detail}` : "Falha ao iniciar";
    }

    if (/^(failed|failure|falhou|falha|erro|error)\b/i.test(lower)) {
      return raw
        .replace(/^failed\b/i, "Falhou")
        .replace(/^failure\b/i, "Falha")
        .replace(/^error\b/i, "Erro");
    }

    if (/^(completed|done|success|sucesso|conclu)/i.test(lower)) {
      if (Number.isFinite(errors) && errors > 0) return `Concluído com ${errors} erro(s)`;
      const detail = raw.replace(/^(completed|done|success|sucesso|conclu[ií]do)\s*:?\s*/i, "").trim();
      if (!detail) return "Concluído";
      if (/^\d+\/\d+/.test(detail)) return `Concluído • ${detail}`;
      return `Concluído: ${detail}`;
    }

    return toTitleCase(raw);
  }

  function isTerminalCompleted(stateText) {
    const t = normalizeStateText(stateText).toLowerCase();
    return /^(conclu|finaliz|completed|done|success|sucesso|cancelado|cancelled|canceled|abortado|aborted)\b/.test(t);
  }

  function isCanceledState(stateText) {
    const t = normalizeStateText(stateText).toLowerCase();
    return /^(cancelado|cancelled|canceled|abortado|aborted)\b/.test(t);
  }

  function isTerminalFailed(stateText) {
    const t = normalizeStateText(stateText).toLowerCase();
    return /^(failed|failure|falh|erro|error)\b/.test(t);
  }

  function isSafetyPausedState(stateText) {
    const t = normalizeStateText(stateText).toLowerCase();
    return /^(paused_safety|pausado por seguran[cç]a)\b/.test(t);
  }

  function isRetryWaitState(stateText) {
    const t = normalizeStateText(stateText).toLowerCase();
    return /^(retry_wait|aguardando retomada autom[aá]tica)\b/.test(t);
  }

  function isReviewPendingState(stateText) {
    const t = normalizeStateText(stateText).toLowerCase();
    return /^(review_pending|em revis[aã]o|revis[aã]o pendente)\b/.test(t);
  }

  function isCooperativeChunkWait(job) {
    return String(job?.queueReason || "").toLowerCase() === "cooperative_chunk";
  }

  function isWaitingState(stateText) {
    const t = normalizeStateText(stateText).toLowerCase();
    return /^(queued|queue|pending|waiting|scheduled|agendado|na fila|aguardando|retry_wait)\b/.test(t);
  }

  function isActiveState(stateText) {
    const t = normalizeStateText(stateText).toLowerCase();
    return /^(active|running|processing|processando|iniciando|cancelando|retry_wait|review_pending|em revis[aã]o)\b/.test(t);
  }

  function isPrematureDownloadError(job) {
    const message = String(job?.error || job?.failedReason || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    return /job ainda nao esta concluido|ainda nao esta concluido para download|csv ainda nao esta pronto/.test(
      message,
    );
  }

  function shouldKeepCurrentState(job, nextState, incomingProgress = null, incomingProcessed = null) {
    if (!job || nextState == null) return false;
    if (isTerminalCompleted(nextState) || isTerminalFailed(nextState)) return false;
    if (isTerminalCompleted(job.state) || isTerminalFailed(job.state)) return false;
    const currentProgress = Number(job.progress || 0);
    const nextProgress = Number(incomingProgress);
    if (Number.isFinite(nextProgress) && nextProgress < currentProgress) return true;
    return isWaitingState(nextState) && (isActiveState(job.state) || currentProgress > 0);
  }

  function monotonicProgress(job, nextProgress, { terminal = false } = {}) {
    if (nextProgress == null) return null;
    const incoming = clamp(nextProgress);
    if (terminal) return incoming;
    const current = clamp(job?.progress ?? 0);
    return incoming < current ? current : incoming;
  }

  function isJobVisible(job) {
    if (!job || job.dismissed) return false;
    if (!job.completed) return true;

    const now = Date.now();
    const updated = Number(job.updated || 0);
    const ageMs = updated > 0 ? Math.max(0, now - updated) : Number.POSITIVE_INFINITY;

    if (isTerminalFailed(job.state)) {
      return ageMs <= RECENT_FAILED_MS;
    }

    return ageMs <= RECENT_COMPLETED_MS;
  }

  function getVisibleJobs() {
    const query = String(searchQuery || "").trim().toLowerCase().replace(/^#/, "");
    const matchesSearch = (job) => {
      if (!query) return true;
      const backendId = String(job?.backendJobId || "").toLowerCase();
      const localId = String(job?.id || "").toLowerCase();
      const operationId = String(job?.operationId || "").toLowerCase();
      const title = String(job?.title || "").toLowerCase();
      const account = String(job?.accountLabel || job?.accountKey || "").toLowerCase();
      return [backendId, localId, operationId, title, account].some((value) =>
        value.includes(query),
      );
    };

    const sorted = jobs
      .filter((j) => !j.dismissed)
      .filter(isVisibleByFilter)
      .filter(matchesSearch)
      .sort(compareJobs);

    const running = sorted.filter((j) => !j.completed);
    const recentDone = sorted.filter((j) => j.completed && (query || isJobVisible(j)));

    return [...running, ...recentDone]
      .sort(compareJobs)
      .slice(0, query ? Math.max(MAX_VISIBLE_JOBS, 25) : MAX_VISIBLE_JOBS);
  }

  function hasRunningJobs() {
    return jobs.some(
      (job) => job && !job.dismissed && !job.completed && isVisibleByFilter(job),
    );
  }

  function findJobByIdentity(id, adapterName = defaultAdapter) {
    const raw = String(id || "").trim();
    if (!raw) return null;
    const identity = normalizePanelIdentity(raw, adapterName);
    return jobs.find((job) => {
      if (!job) return false;
      if (job.id === raw || job.id === identity.uid) return true;
      const backendJobId = String(job.backendJobId || "").trim();
      return backendJobId && (backendJobId === raw || backendJobId === identity.backendJobId);
    }) || null;
  }

  function isJobVisibleForCurrentScope(jobOrId) {
    const job =
      jobOrId && typeof jobOrId === "object"
        ? jobOrId
        : findJobByIdentity(jobOrId);
    if (!job) return true;
    return isVisibleByFilter(job);
  }

  function renderBadge(job) {
    const key = String(job.accountKey || "").trim();
    const label = job.accountLabel || job.accountKey || "";
    if (!key && !label) return "";
    return `<span class="job-badge">${esc(label || key)}</span>`;
  }

  function formatRelativeTime(value) {
    const ts = normalizeTimestamp(value, 0);
    if (!ts) return "";
    const diffMs = Math.max(0, Date.now() - ts);
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return "agora";
    if (minutes < 60) return `há ${minutes}min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `há ${hours}h`;
    const days = Math.floor(hours / 24);
    return `há ${days}d`;
  }

  function jobTone(job, hasReviewAlert) {
    if (hasReviewAlert || isTerminalFailed(job?.state) || isSafetyPausedState(job?.state)) {
      return "error";
    }
    if (job?.completed) return "ok";
    return "proc";
  }

  function renderJobIcon(tone) {
    if (tone === "ok") return `<div class="job-icon job-icon--ok" aria-hidden="true">&#10003;</div>`;
    if (tone === "error") return `<div class="job-icon job-icon--error" aria-hidden="true">!</div>`;
    return `<div class="job-icon job-icon--processing" aria-hidden="true"></div>`;
  }

  function renderStatusPill(tone, job) {
    if (tone === "ok") return "";
    const state = String(job?.state || "");
    let label = "Processando";
    if (isSafetyPausedState(state)) {
      label = "Pausado por seguranca";
    } else if (isRetryWaitState(state)) {
      label = "Aguardando";
    } else if (isReviewPendingState(state)) {
      label = "Em revisao";
    } else if (isCooperativeChunkWait(job)) {
      label = "Revezando";
    } else if (isWaitingState(state)) {
      label = "Na fila";
    } else if (/^cancelando\b/i.test(state)) {
      label = "Cancelando";
    } else if (tone === "error") {
      label =
        job?.completed && Number(job?.errors || 0) > 0
          ? "Com erros"
          : "Falhou";
    }
    return `<span class="job-status job-status--${tone}">${esc(label)}</span>`;
  }

  function renderJobMeta(job, tone) {
    const account = job.accountLabel || job.accountKey || "";
    const time = formatRelativeTime(job.completedAt || job.updated);
    const state = String(job?.state || "");
    const updatedTs = normalizeTimestamp(job?.updated, 0);
    const stale =
      tone === "proc" &&
      !isRetryWaitState(state) &&
      !/^cancelando\b/i.test(state) &&
      updatedTs > 0 &&
      Date.now() - updatedTs >= 10 * 60 * 1000;
    const status =
      isSafetyPausedState(state)
        ? `pausado${time ? ` ${time}` : ""}`
        : isRetryWaitState(state)
          ? "retomada automatica"
          : isReviewPendingState(state)
            ? "em revisao"
            : isWaitingState(state)
              ? Number.isFinite(Number(job?.queuePosition))
                ? `na fila · posicao ${Math.round(Number(job.queuePosition))}`
                : "aguardando worker"
              : /^cancelando\b/i.test(state)
                ? "cancelando"
                : tone === "ok"
              ? time
              : tone === "error"
                ? "revisar"
                : stale
                  ? `sem atualizacao ${formatRelativeTime(updatedTs)}`
                  : "em andamento";
    return [account, status].filter(Boolean).join(" · ");
  }

  function pluralizeCount(count, singular, plural) {
    return `${count} ${count === 1 ? singular : plural}`;
  }

  function renderJobChips(job, tone) {
    const processed = Number(job?.processed);
    const success = Number(job?.success);
    const total = Number(job?.total);
    const errors = Number(job?.errors || 0);
    const fallbackDone =
      job?.completed && Number.isFinite(total) && total > 0
        ? Math.max(0, total - (Number.isFinite(errors) ? errors : 0))
        : NaN;
    const doneCount =
      Number.isFinite(success)
        ? success
        : Number.isFinite(processed) && processed > 0
          ? processed
          : fallbackDone;
    const parts = [];

    if (Number.isFinite(doneCount) && doneCount >= 0 && (doneCount > 0 || job?.completed)) {
      parts.push(`<span class="chip--ok">${esc(pluralizeCount(doneCount, "concluido", "concluidos"))}</span>`);
    } else if (tone === "ok") {
      parts.push(`<span class="chip--ok">1 concluido</span>`);
    }

    const hasErrorDetailsAction = !!job?.reviewAction?.url;
    const showErrorChip =
      Number.isFinite(errors) &&
      errors > 0 &&
      (!job?.completed || hasErrorDetailsAction);
    if (showErrorChip) {
      if (parts.length) parts.push(`<span class="chip-div" aria-hidden="true"></span>`);
      parts.push(`<span class="chip--err">${esc(`${errors} com erro${errors === 1 ? "" : "s"}`)}</span>`);
    }

    return parts.length ? `<div class="job-chips">${parts.join("")}</div>` : "";
  }

  function renderJobError(job) {
    const errors = Number(job?.errors || 0);
    if (!Number.isFinite(errors) || errors <= 0) return "";
    const terminal =
      !!job?.completed ||
      isTerminalCompleted(job?.state) ||
      isTerminalFailed(job?.state);
    if (!terminal) return "";
    const message = String(job?.error || job?.failedReason || "").trim();
    if (message) {
      return `<div class="job-error-msg">${esc(message)}</div>`;
    }
    if (!job?.reviewAction?.url) {
      return `<div class="job-error-msg">${esc(pluralizeCount(errors, "item terminou com erro", "itens terminaram com erro"))}.</div>`;
    }
    return `<div class="job-error-msg">${esc(pluralizeCount(errors, "anuncio nao foi processado", "anuncios nao foram processados"))}. O relatorio contem os detalhes.</div>`;
  }

  function renderReviewAction(job) {
    const action = job && job.reviewAction;
    if (isCanceledState(job?.state) || isCanceledState(job?.status)) return "";
    const terminal =
      !!job?.completed ||
      isTerminalCompleted(job?.state) ||
      isTerminalFailed(job?.state);
    if (!terminal) return "";
    const inferredUrl = inferReviewActionUrl(job);
    const actionUrl = action?.url || inferredUrl;
    if (!actionUrl) return "";
    const inferredFiltroQueryAction = !action?.url && !!inferredUrl && isFiltroQueryTitle(job?.title);
    const count =
      Number.isFinite(Number(job?.errors)) && Number(job.errors) > 0
        ? Number(job.errors)
        : 0;
    const href = withBase(actionUrl);
    const isPreparing = preparingDownloads.has(String(job.id || ""));
    const actionLabel =
      action?.label ||
      (inferredFiltroQueryAction
        ? "Gerar CSV"
        : count > 0
          ? `Ver e corrigir (${count})`
          : "Baixar CSV");
    return `<a class="btn-csv job-review${isPreparing ? " is-preparing" : ""}" data-id="${esc(
      job.id
    )}" data-filename="${esc(action?.filename || "")}" href="${esc(href)}" download rel="noopener" aria-busy="${isPreparing ? "true" : "false"}" title="${esc(
      actionLabel
    )}">${isPreparing ? "Preparando..." : esc(actionLabel)}</a>`;
  }

  function renderResumeAction(job) {
    if (job?.resumable !== true || !job?.resumeUrl) return "";
    const pending = Number(job.pending || 0);
    const label = pending > 0 ? `Continuar pendentes (${pending})` : "Continuar pendentes";
    return `<button type="button" class="btn-csv job-resume" data-id="${esc(
      job.id,
    )}" data-url="${esc(withBase(job.resumeUrl))}">${esc(label)}</button>`;
  }

  function renderFullReportAction(job) {
    if (!job?.fullReportUrl || job?.reviewAction?.url === job.fullReportUrl) return "";
    const processed = Number(job?.processed || 0);
    if (!job?.completed && processed <= 0) return "";
    const label = job?.completed ? "Baixar XLSX" : "Baixar XLSX parcial";
    return `<a class="btn-csv job-review" data-id="${esc(job.id)}-full" href="${esc(
      withBase(job.fullReportUrl),
    )}" download rel="noopener">${esc(label)}</a>`;
  }

  function inferReviewActionUrl(job) {
    const id = String(job?.backendJobId || job?.id || "").trim();
    if (!id) return "";
    if (isFiltroQueryTitle(job?.title)) {
      return `/api/analytics/filtro-anuncios/jobs/${encodeURIComponent(id)}/download.csv`;
    }
    return "";
  }

  function isFiltroQueryTitle(value) {
    const title = normalizeScopeToken(value || "");
    return title.includes("filtro") && title.includes("anuncio");
  }

  function filenameFromDisposition(disposition, fallback = "download.csv") {
    const raw = String(disposition || "");
    const utf = raw.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf) {
      try {
        return decodeURIComponent(utf[1].replace(/["]/g, "").trim()) || fallback;
      } catch {}
    }
    const simple = raw.match(/filename="?([^";]+)"?/i);
    return simple?.[1]?.trim() || fallback;
  }

  function buildExportStatusUrl(data, downloadUrl, exportJobId) {
    const explicit = String(
      data?.endpoints?.status_url || data?.status_url || data?.statusUrl || "",
    ).trim();
    if (explicit) return withBase(explicit);

    const id = encodeURIComponent(String(exportJobId || "").trim());
    if (!id) return "";

    const rawUrl = String(downloadUrl || "").trim();
    try {
      const u = new URL(rawUrl, window.location.origin);
      u.pathname = u.pathname.replace(/\/jobs\/[^/]+\/download\.csv$/i, `/jobs/${id}`);
      u.search = "";
      return u.pathname + u.search;
    } catch {}

    return rawUrl.replace(/\/jobs\/[^/]+\/download\.csv(?:\?.*)?$/i, `/jobs/${id}`);
  }

  function isTerminalApiJob(data) {
    const status = normalizeStateText(
      data?.status || data?.state || data?.lifecycle_status || data?.result || "",
    );
    if (isTerminalCompleted(status) || isTerminalFailed(status)) return true;
    return data?.completed === true || data?.terminal === true;
  }

  function watchApiJobStatus({ jobId, statusUrl, adapter = defaultAdapter } = {}) {
    const id = String(jobId || "").trim();
    const url = withBase(String(statusUrl || "").trim());
    if (!id || !url) return;

    const key = `${adapter}:${id}`;
    if (activeApiWatchers.has(key)) return;
    activeApiWatchers.add(key);

    let delay = 1200;
    let stopped = false;
    const stop = () => {
      stopped = true;
      activeApiWatchers.delete(key);
    };

    const tick = async () => {
      if (stopped || !activeApiWatchers.has(key)) return;
      try {
        const response = await fetch(url, {
          credentials: "same-origin",
          cache: "no-store",
        });
        const data = await response.json().catch(() => null);
        if (response.ok && data && data.ok !== false) {
          mergeApiJobs([data], { adapter });
          if (isTerminalApiJob(data)) {
            stop();
            return;
          }
        } else if (response.status === 404 || response.status === 401 || response.status === 403) {
          stop();
          return;
        }
      } catch (error) {
        console.warn("[JobsPanel] falha ao acompanhar job:", error?.message || error);
      }

      delay = Math.min(5000, Math.round(delay * 1.35));
      window.setTimeout(tick, delay);
    };

    window.setTimeout(tick, 350);
  }

  async function downloadReviewCsv(link) {
    if (!link) return;
    const jobId = String(link.dataset.id || "").trim();
    const url = link.getAttribute("href") || "";
    if (!url || preparingDownloads.has(jobId || url)) return;
    const key = jobId || url;

    preparingDownloads.add(key);
    render();
    try {
      const response = await fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 202) {
        const data = await response.json().catch(() => ({}));
        const exportJobId = String(data.export_job_id || data.job_id || "").trim();
        if (exportJobId) {
          const statusUrl = buildExportStatusUrl(data, url, exportJobId);
          updateLocalJob(exportJobId, {
            title: "Exportacao CSV enriquecida",
            state: "aguardando",
            progress: 0,
            completed: false,
            adapter: "filtro-anuncios",
          });
          show();
          render();
          watchApiJobStatus({
            jobId: exportJobId,
            statusUrl,
            adapter: "filtro-anuncios",
          });
          return;
        }
      }
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        let data = null;
        try {
          data = await response.clone().json();
          message = data?.error || data?.message || message;
        } catch {}
        if (response.status === 409 && jobId) {
          const statusText = String(data?.status || "").trim();
          const normalizedMessage = String(message || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase();
          const isCanceledDownload =
            /^(cancelado|canceled|cancelled|abortado|aborted)$/i.test(statusText) ||
            /job cancelado|cancelad/.test(normalizedMessage);
          const isStillRunning =
            !isCanceledDownload &&
            /nao esta concluido|ainda nao esta pronto/.test(normalizedMessage);
          const isFailedDownload =
            isCanceledDownload ||
            /^(erro|failed|falhou|cancelado|canceled|cancelled)$/i.test(statusText) ||
            /nao est[aá] conclu[ií]do|nao esta concluido/.test(normalizedMessage);
          if (isStillRunning) {
            updateLocalJob(jobId, {
              state: statusText || "processando",
              completed: false,
              errors: 0,
              error: null,
              failedReason: null,
              reviewAction: null,
              downloadCsvUrl: null,
            });
            return;
          } else if (isFailedDownload) {
            updateLocalJob(jobId, {
              state: statusText || message,
              progress: 100,
              completed: true,
              errors: 1,
              error: message,
              reviewAction: null,
              downloadCsvUrl: null,
            });
          }
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const hrefPath = (() => {
        try {
          return new URL(url, window.location.href).pathname;
        } catch {
          return url;
        }
      })();
      const isXlsx = /\.xlsx(?:$|\?)/i.test(String(hrefPath || ""));
      const filename = filenameFromDisposition(
        response.headers.get("Content-Disposition"),
        String(link.dataset.filename || "").trim() ||
          `${jobId || "resultado"}${isXlsx ? ".xlsx" : "_filtro_anuncios.csv"}`,
      );
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
    } catch (error) {
      console.error("[JobsPanel] falha ao preparar relatorio:", error);
      alert("Não foi possível preparar o relatório: " + (error.message || error));
    } finally {
      preparingDownloads.delete(key);
      render();
    }
  }

  function formatEta(seconds) {
    const total = Number(seconds);
    if (!Number.isFinite(total) || total <= 0) return "";
    const mins = Math.max(1, Math.round(total / 60));
    if (mins < 60) return `~${mins}min`;
    const hours = Math.floor(mins / 60);
    const rest = mins % 60;
    return rest ? `~${hours}h ${rest}min` : `~${hours}h`;
  }

  function renderPerformance(job) {
    if (job?.completed || isSafetyPausedState(job?.state)) return "";
    if (isReviewPendingState(job?.state)) {
      const pending = Number(job?.remediationPending || 0);
      return pending > 0
        ? `<div class="job-performance">${esc(`${pending} verificacao(oes) pendente(s) antes de concluir`)}</div>`
        : "";
    }
    if (isWaitingState(job?.state) && !isRetryWaitState(job?.state)) {
      const parts = [];
      if (isCooperativeChunkWait(job)) {
        parts.push("fatia concluida");
        parts.push("aguardando o proximo turno");
        return `<div class="job-performance">${esc(parts.join(" · "))}</div>`;
      }
      const position = Number(job?.queuePosition);
      const waitSeconds = Number(job?.queueWaitSeconds || 0);
      if (Number.isFinite(position) && position > 0) parts.push(`posicao ${Math.round(position)} na fila da conta`);
      if (waitSeconds > 0) parts.push(`aguardando ${formatEta(waitSeconds) || `${Math.round(waitSeconds)}s`}`);
      if (job?.workerDelayed === true || job?.workerStatus === "offline") {
        parts.push("worker sem heartbeat recente");
      } else {
        parts.push("aguardando worker");
      }
      return `<div class="job-performance">${esc(parts.join(" · "))}</div>`;
    }
    const rate = Number(job?.itemsPerMinute);
    const eta = formatEta(job?.etaSeconds);
    const concurrency = Number(job?.itemConcurrency);
    const parts = [];
    if (Number.isFinite(rate) && rate > 0) parts.push(`${rate.toFixed(rate >= 10 ? 0 : 1)} itens/min`);
    if (eta) parts.push(`restante ${eta}`);
    if (Number.isFinite(concurrency) && concurrency > 0) parts.push(`x${Math.round(concurrency)}`);
    if (job?.stalledWarning === true) parts.push("sem heartbeat de progresso");
    return parts.length ? `<div class="job-performance">${esc(parts.join(" · "))}</div>` : "";
  }

  function renderRemediationSummary(job) {
    const total = Number(job?.remediationTotal || 0);
    if (!Number.isFinite(total) || total <= 0) return "";
    const pending = Number(job?.remediationPending || 0);
    const resolved = Number(job?.remediationResolved || 0);
    const critical = Number(job?.remediationCritical || 0);
    const parts = [`${total} ${total === 1 ? "item" : "itens"} em remediação`];
    if (pending > 0) parts.push(`${pending} pendente${pending === 1 ? "" : "s"}`);
    if (resolved > 0) parts.push(`${resolved} resolvido${resolved === 1 ? "" : "s"}`);
    if (critical > 0) parts.push(`${critical} crítico${critical === 1 ? "" : "s"}`);
    return `<div class="job-performance">${esc(parts.join(" · "))}</div>`;
  }

  function supportSummary(job) {
    const backend = displayBackendJobId(job) || String(job?.backendJobId || "");
    const lines = [
      `Job: ${backend || "-"}`,
      job?.operationId ? `Operacao: ${job.operationId}` : null,
      `Conta: ${job?.accountLabel || job?.accountKey || "-"}`,
      `Processo: ${job?.title || "-"}`,
      `Status: ${job?.state || "-"}`,
      `Processados: ${Number(job?.processed || 0)}/${Number(job?.total || 0)}`,
      `Sucessos: ${Number(job?.success || 0)}`,
      `Erros: ${Number(job?.errors || 0)}`,
      job?.error ? `Ultimo erro: ${job.error}` : null,
    ].filter(Boolean);
    return lines.join("\n");
  }

  function renderSupportAction(job) {
    if (!job?.backendJobId) return "";
    return `<button type="button" class="btn-support job-support" data-id="${esc(job.id)}" title="Copiar dados para suporte">Copiar</button>`;
  }

  function displayBackendJobId(job) {
    const raw = String(job?.backendJobId || "").trim();
    if (!raw) return "";
    const numeric = raw.match(/^(?:promo:)?(\d+)$/i);
    return numeric ? `#${numeric[1]}` : `#${raw.replace(/^promo:/i, "")}`;
  }

  function renderJobNumber(job) {
    const label = displayBackendJobId(job);
    if (!label) return "";
    return `<button type="button" class="job-number" data-copy-job-id="${esc(
      String(job?.backendJobId || ""),
    )}" title="Copiar identificador do job">${esc(label)}</button>`;
  }

  function render() {
    const root = ensurePanel();
    if (!root) {
      schedulePersistJobs();
      return;
    }

    const currentList = root.querySelector(".processos-panel__list");
    if (currentList) {
      panelScrollTop = currentList.scrollTop;
    }

    root.classList.add("processos-panel");
    root.classList.remove("jobs-panel");
    root.classList.toggle("collapsed", !!collapsed);
    root.classList.toggle("hidden", !!panelHidden);

    const visibleJobs = getVisibleJobs();
    const renderJobRow = (j) => {
      const pct = clamp(j.progress);
      const stateText = humanizeState(
        j.state,
        pct,
        Number(j.processed),
        Number(j.total),
        Number(j.errors)
      );
      const hasReviewAlert =
        j.completed &&
        Number.isFinite(Number(j.errors)) &&
        Number(j.errors) > 0;
      const tone = jobTone(j, hasReviewAlert);
      const progressClass =
        tone === "ok"
          ? "job-bar__fill--ok"
          : tone === "error"
            ? "job-bar__fill--error"
            : "job-bar__fill--proc";
      const total = Number(j.total);
      const processed = Number(j.processed);
      const totalLabel =
        Number.isFinite(total) && total > 0
          ? j.completed && hasReviewAlert && Number.isFinite(processed) && processed >= 0
            ? `${processed} de ${total} itens`
            : pluralizeCount(total, "item", "itens")
          : "";
      const title = j.title || "Processo";
      const metaText = renderJobMeta(j, tone);
      const reviewAction = renderReviewAction(j);
      const resumeAction = renderResumeAction(j);
      const fullReportAction = renderFullReportAction(j);
      const displayState = isCanceledState(j.state) || isCanceledState(j.status)
        ? stateText
        : j.completed && tone !== "error"
          ? "Concluido"
          : stateText;
      const actionInfoText =
        j.completed && tone === "ok"
          ? ""
          : j.completed
            ? totalLabel || displayState
            : displayState;
      const dismissButton = `<button class="processos-panel__btn job-dismiss" data-id="${esc(
        j.id
      )}" title="${j.completed ? "Fechar" : "Cancelar processamento"}">&times;</button>`;
      const jobNumber = renderJobNumber(j);

      return `
<div class="job-item${j.completed ? " done" : ""}${hasReviewAlert ? " needs-review" : ""}" data-tone="${tone}">
  ${renderJobIcon(tone)}
  <div class="job-content">
    <div class="job-main-line">
      <div class="job-title-block">
        <div class="job-name-row">
          <div class="job-name">${esc(title)}</div>
          ${jobNumber}
        </div>
        ${metaText ? `<div class="job-meta">${esc(metaText)}</div>` : ""}
      </div>
      ${dismissButton}
    </div>
    <div class="job-state-line">
      ${renderStatusPill(tone, j)}
      ${renderBadge(j)}
    </div>
    <div class="job-progress-line">
      <div class="job-bar"><div class="${progressClass}" style="width:${pct}%;"></div></div>
      <span class="job-pct">${pct}%</span>
    </div>
    ${renderJobChips(j, tone)}
    ${renderPerformance(j)}
    ${renderRemediationSummary(j)}
    ${renderJobError(j)}
    <div class="job-actions">
      ${actionInfoText ? `<span class="job-loading-text">${esc(actionInfoText)}</span>` : ""}
      <span class="job-action-buttons">${renderSupportAction(j)}${resumeAction}${reviewAction}${fullReportAction}</span>
    </div>
  </div>
</div>`;
    };

    const renderSection = (label, list) =>
      list.length
        ? `<div class="processos-panel__section">${label}</div>${list.map(renderJobRow).join("")}`
        : "";
    const queuedJobs = visibleJobs.filter(
      (job) =>
        !job.completed &&
        isWaitingState(job?.state) &&
        !isReviewPendingState(job?.state) &&
        !isCooperativeChunkWait(job),
    );
    const runningJobs = visibleJobs.filter(
      (job) => !job.completed && !queuedJobs.includes(job),
    );
    const completedJobs = visibleJobs.filter((job) => job.completed);
    const rows = [
      renderSection("EM ANDAMENTO", runningJobs),
      renderSection("NA FILA", queuedJobs),
      renderSection("CONCLUIDOS", completedJobs),
    ].filter(Boolean).join("");

    root.innerHTML = `
<div class="processos-panel__header">
  <span class="processos-panel__title">Processos <span class="processos-panel__count">${visibleJobs.length}</span></span>
  <div class="processos-panel__actions">
    <button class="processos-panel__btn" id="jpToggle" title="${
      collapsed ? "Maximizar" : "Minimizar"
    }">${collapsed ? "+" : "&minus;"}</button>
    <button class="processos-panel__btn" id="jpClose" title="Esconder">&times;</button>
  </div>
</div>
<div class="processos-panel__search"${collapsed ? ' style="display:none"' : ""}>
  <input id="jpSearch" type="search" autocomplete="off" placeholder="Buscar #job, operacao ou conta" value="${esc(
    searchQuery,
  )}" aria-label="Buscar processo por job, operacao ou conta" />
</div>
<div class="processos-panel__list"${collapsed ? ' style="display:none"' : ""}>
  ${rows || '<div class="processos-panel__empty">Sem processos recentes.</div>'}
</div>
<div class="processos-panel__footer">
  <button class="btn-clear" id="jpClearCompleted">Limpar concluídos</button>
</div>`;

    const nextList = root.querySelector(".processos-panel__list");
    if (nextList) {
      const maxScrollTop = Math.max(0, nextList.scrollHeight - nextList.clientHeight);
      nextList.scrollTop = Math.min(panelScrollTop, maxScrollTop);
      nextList.addEventListener("scroll", () => {
        panelScrollTop = nextList.scrollTop;
      }, { passive: true });
    }

    root.querySelector("#jpToggle")?.addEventListener("click", () => {
      collapsed = !collapsed;
      render();
    });
    root.querySelector("#jpClose")?.addEventListener("click", () => {
      hide();
      render();
    });
    root.querySelector("#jpClearCompleted")?.addEventListener("click", () => {
      jobs
        .filter((job) => job && job.completed)
        .forEach((job) => dismissJobId(job.id));
      render();
    });

    const searchInput = root.querySelector("#jpSearch");
    searchInput?.addEventListener("input", (ev) => {
      searchQuery = String(ev.currentTarget?.value || "");
      render();
      const nextInput = root.querySelector("#jpSearch");
      if (nextInput) {
        nextInput.focus();
        const len = nextInput.value.length;
        try { nextInput.setSelectionRange(len, len); } catch {}
      }
    });

    root.querySelectorAll(".job-number").forEach((button) => {
      button.addEventListener("click", async (ev) => {
        const rawId = String(ev.currentTarget?.dataset?.copyJobId || "").trim();
        if (!rawId) return;
        try {
          await navigator.clipboard.writeText(rawId);
          const original = ev.currentTarget.textContent;
          ev.currentTarget.textContent = "Copiado";
          setTimeout(() => {
            if (ev.currentTarget?.isConnected) ev.currentTarget.textContent = original;
          }, 900);
        } catch {
          window.prompt("Copie o identificador do job:", rawId);
        }
      });
    });

    root.querySelectorAll(".job-support").forEach((button) => {
      button.addEventListener("click", async (ev) => {
        const job = jobs.find((entry) => entry.id === ev.currentTarget?.dataset?.id);
        if (!job) return;
        const text = supportSummary(job);
        try {
          await navigator.clipboard.writeText(text);
          const original = ev.currentTarget.textContent;
          ev.currentTarget.textContent = "Copiado";
          setTimeout(() => {
            if (ev.currentTarget?.isConnected) ev.currentTarget.textContent = original;
          }, 900);
        } catch {
          window.prompt("Copie os dados para o suporte:", text);
        }
      });
    });

    root.querySelectorAll(".job-review").forEach((link) => {
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        downloadReviewCsv(ev.currentTarget).catch(console.error);
      });
    });

    root.querySelectorAll(".job-resume").forEach((button) => {
      button.addEventListener("click", async (ev) => {
        const btn = ev.currentTarget;
        const job = jobs.find((entry) => entry.id === btn.dataset.id);
        if (!job || !btn.dataset.url) return;
        if (!confirm("Continuar somente os itens pendentes? Todos serao revalidados antes da aplicacao.")) return;
        btn.disabled = true;
        try {
          const response = await fetch(btn.dataset.url, {
            method: "POST",
            credentials: "same-origin",
            headers: { Accept: "application/json" },
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || !payload?.job_id) {
            throw new Error(payload?.error || "Nao foi possivel retomar o processamento.");
          }
          job.resumable = false;
          job.state = `retomado em ${payload.job_id}`;
          render();
        } catch (error) {
          alert(error?.message || "Nao foi possivel retomar o processamento.");
          if (btn.isConnected) btn.disabled = false;
        }
      });
    });

    root.querySelectorAll(".job-dismiss").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        const button = ev.currentTarget;
        const id = button.dataset.id;
        const job = jobs.find((x) => x.id === id);
        if (!job) return;

        if (!job.completed && typeof cancelHandler === "function") {
          const confirmed = window.confirm(
            "Cancelar esta aplicacao?\n\nOs anuncios ja processados permanecerao como estao. Nenhum novo item pendente sera aplicado. Correcoes de seguranca/rollback ja iniciadas continuarao ate terminar.",
          );
          if (!confirmed) return;

          try {
            if (button && button.isConnected) button.disabled = true;
            const result = await cancelHandler({ ...job });
            const accepted = result === true || result?.ok === true;
            if (!accepted) {
              const message =
                result?.error ||
                result?.message ||
                "Nao foi possivel cancelar o processamento no backend.";
              window.alert(message);
              if (button && button.isConnected) button.disabled = false;
              return;
            }

            // Cancelar e fechar sao acoes diferentes. O card continua visivel
            // ate o backend confirmar o estado final; depois o X passa a apenas fechar.
            render();
            return;
          } catch (error) {
            window.alert(error?.message || "Nao foi possivel cancelar o processamento.");
            if (button && button.isConnected) button.disabled = false;
            return;
          }
        }

        dismissJobId(id);
        render();
      });
    });

    schedulePersistJobs();
  }
  function ensureJob(id, adapterName = defaultAdapter, backendJobId = null) {
    const identity = normalizePanelIdentity(id, adapterName, backendJobId);
    const jobId = identity.uid;
    if (!jobId) return null;

    let j = jobs.find((x) => x.id === jobId);
    if (!j) {
      j = {
        id: jobId,
        title: "Processo",
        progress: 0,
        state: "iniciando…",
        completed: false,
        locked: false, // 🔒 trava depois que concluir pra não virar "failed" por poller
        dismissed: dismissedJobIds.has(jobId),
        updated: Date.now(),
        sortOrder: nextSortOrder++,
        completedAt: 0,
        reviewAction: null,
        adapter: identity.adapter,
        backendJobId: identity.backendJobId,
        source: "local",
      };
      jobs.push(j);
    } else if (!j.backendJobId && identity.backendJobId) {
      j.backendJobId = identity.backendJobId;
    }
    return j;
  }

  function addLocalJob({ title, accountKey, accountLabel, state, progress, adapter, source }) {
    const currentScope = getActiveAccountDisplayScope();
    const rawId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const identity = normalizePanelIdentity(rawId, adapter || defaultAdapter, rawId);
    const id = identity.uid;
    jobs.push({
      id,
      title: title || "Processo",
      progress: typeof progress === "number" ? clamp(progress) : 0,
      state: normalizeStateText(state || "Preparando..."),
      completed: false,
      locked: false,
      dismissed: dismissedJobIds.has(id),
      accountKey: accountKey || currentScope.key || null,
      accountLabel: accountLabel || currentScope.label || null,
      updated: Date.now(),
      sortOrder: nextSortOrder++,
      completedAt: 0,
      adapter: String(adapter || defaultAdapter || "generic"),
      backendJobId: identity.backendJobId,
      source: String(source || "local"),
    });
    show();
    render();
    return id;
  }

  // ✅ update "seguro": se já concluiu, não deixa rebaixar pra failed
  function updateLocalJob(
    id,
    {
      progress,
      state,
      completed,
      accountKey,
      accountLabel,
      title,
      processed,
      success,
      total,
      errors,
      reviewAction,
      downloadCsvUrl,
      error,
      failedReason,
      adapter,
      resumable,
      safetyPaused,
      cancelRequested,
      fullReportUrl,
      operationId,
    }
  ) {
    const j = ensureJob(id, adapter || defaultAdapter);
    if (!j) return;
    if (j.dismissed) return;
    let changed = false;

    const rawNextProgress = typeof progress === "number" ? clamp(progress) : null;
    const nextState = state != null ? normalizeStateText(state) : null;
    const nextCompleted = typeof completed === "boolean" ? completed : null;
    const nextErrorsValue = Number(errors);
    const hasNextErrors = Number.isFinite(nextErrorsValue) && nextErrorsValue > 0;
    const nextFailed = !!nextState && isTerminalFailed(nextState);
    const isAuthoritativeLiveUpdate =
      nextCompleted === false &&
      !!nextState &&
      (isActiveState(nextState) || isWaitingState(nextState));
    const recoveringPrematureTerminal =
      isAuthoritativeLiveUpdate && (j.completed || j.locked || Number(j.progress || 0) >= 100);
    const nextProgress = recoveringPrematureTerminal
      ? rawNextProgress
      : monotonicProgress(j, rawNextProgress, {
          terminal:
            nextCompleted === true ||
            isTerminalCompleted(nextState) ||
            nextFailed,
        });

    // Se já está travado/concluído e veio update "failed", ignora
    if ((j.locked || j.completed) && nextFailed && !hasNextErrors) {
      render();
      return;
    }

    if (nextProgress != null && j.progress !== nextProgress) {
      j.progress = nextProgress;
      changed = true;
    }

    if (
      nextState != null &&
      j.state !== nextState &&
      !shouldKeepCurrentState(j, nextState, rawNextProgress, processed)
    ) {
      j.state = nextState;
      changed = true;
    }

    if (nextCompleted != null && j.completed !== nextCompleted) {
      j.completed = nextCompleted;
      if (nextCompleted) {
        j.completedAt = Number(j.completedAt || 0) || Date.now();
      } else if (j.completedAt) {
        j.completedAt = 0;
      }
      changed = true;
    }
    if (nextCompleted === false && j.locked) {
      j.locked = false;
      changed = true;
    }

    if (title != null) {
      const nextTitle = String(title || "Processo");
      if (j.title !== nextTitle) {
        j.title = nextTitle;
        changed = true;
      }
    }
    if (processed != null && Number.isFinite(Number(processed))) {
      const nextProcessed = Number(processed);
      if (j.processed !== nextProcessed) {
        j.processed = nextProcessed;
        changed = true;
      }
    }
    if (success != null && Number.isFinite(Number(success))) {
      const nextSuccess = Number(success);
      if (j.success !== nextSuccess) {
        j.success = nextSuccess;
        changed = true;
      }
    }
    if (total != null && Number.isFinite(Number(total))) {
      const nextTotal = Number(total);
      if (j.total !== nextTotal) {
        j.total = nextTotal;
        changed = true;
      }
    }
    if (errors != null && Number.isFinite(Number(errors))) {
      const nextErrors = Number(errors);
      if (j.errors !== nextErrors) {
        j.errors = nextErrors;
        changed = true;
      }
    }
    const nextError = String(error || failedReason || "").trim();
    if (error === null && failedReason === null && (j.error || j.failedReason)) {
      j.error = null;
      j.failedReason = null;
      changed = true;
    } else if (nextError && j.error !== nextError) {
      j.error = nextError;
      j.failedReason = nextError;
      changed = true;
    }
    const shouldClearReviewAction =
      reviewAction === null ||
      downloadCsvUrl === null ||
      nextFailed ||
      (nextCompleted === true && hasNextErrors && !reviewAction && !downloadCsvUrl);
    if (shouldClearReviewAction) {
      if (j.reviewAction) {
        j.reviewAction = null;
        changed = true;
      }
    } else if (reviewAction && typeof reviewAction === "object" && reviewAction.url) {
      const nextReviewAction = {
        label: reviewAction.label || "Baixar CSV",
        url: reviewAction.url,
        filename: String(reviewAction.filename || "").trim() || null,
      };
      if (
        j.reviewAction?.label !== nextReviewAction.label ||
        j.reviewAction?.url !== nextReviewAction.url ||
        j.reviewAction?.filename !== nextReviewAction.filename
      ) {
        j.reviewAction = nextReviewAction;
        changed = true;
      }
    } else if (downloadCsvUrl) {
      const nextReviewAction = {
        label:
          Number.isFinite(Number(j.errors)) && Number(j.errors) > 0
            ? "Ver e corrigir"
            : "Baixar CSV",
        url: String(downloadCsvUrl),
      };
      if (
        j.reviewAction?.label !== nextReviewAction.label ||
        j.reviewAction?.url !== nextReviewAction.url
      ) {
        j.reviewAction = nextReviewAction;
        changed = true;
      }
    }

    if (accountKey != null && j.accountKey !== accountKey) {
      j.accountKey = accountKey;
      changed = true;
    }
    if (accountLabel != null && j.accountLabel !== accountLabel) {
      j.accountLabel = accountLabel;
      changed = true;
    }
    if (typeof resumable === "boolean" && j.resumable !== resumable) {
      j.resumable = resumable;
      changed = true;
    }
    if (typeof safetyPaused === "boolean" && j.safetyPaused !== safetyPaused) {
      j.safetyPaused = safetyPaused;
      changed = true;
    }
    if (typeof cancelRequested === "boolean" && j.cancelRequested !== cancelRequested) {
      j.cancelRequested = cancelRequested;
      changed = true;
    }
    if (fullReportUrl != null && j.fullReportUrl !== String(fullReportUrl)) {
      j.fullReportUrl = String(fullReportUrl);
      changed = true;
    }
    if (operationId != null && j.operationId !== String(operationId)) {
      j.operationId = String(operationId);
      changed = true;
    }
    if (adapter != null && j.adapter !== String(adapter)) {
      j.adapter = String(adapter);
      changed = true;
    }

    // Counts and percentages describe progress; they do not define lifecycle.
    if (nextCompleted == null) {
      const autoDone =
        j.completed ||
        isTerminalCompleted(j.state) ||
        isTerminalFailed(j.state);

      if (autoDone && !j.completed) {
        j.completed = true;
        j.completedAt = Number(j.completedAt || 0) || Date.now();
        changed = true;
      }
    }

    // Se concluiu, padroniza e trava
    if (j.completed) {
      if (j.progress < 100) {
        j.progress = 100;
        changed = true;
      }
      const currentHasErrors =
        Number.isFinite(Number(j.errors)) && Number(j.errors) > 0;
      if (!j.state) j.state = "concluído";
      if (isTerminalFailed(j.state) && !nextFailed) j.state = "concluído";
      if (currentHasErrors && nextFailed && nextState && j.state !== nextState) {
        j.state = nextState;
        changed = true;
      }
      if (!j.locked) {
        j.locked = true;
        changed = true;
      }
    }

    if (changed) j.updated = Date.now();
    render();
  }

  function replaceId(oldId, newId) {
    const oldIdentity = normalizePanelIdentity(oldId, defaultAdapter);
    const newIdentity = normalizePanelIdentity(newId, defaultAdapter);
    const oldStr = oldIdentity.uid;
    const newStr = newIdentity.uid;
    if (!newStr) return oldStr;
    if (oldStr === newStr) return newStr;

    if (dismissedJobIds.has(oldStr)) {
      dismissedJobIds.delete(oldStr);
      forgetDismissedJobId(oldStr);
      dismissedJobIds.add(newStr);
      persistDismissedJobId(newStr);
    }

    let job = jobs.find((j) => j.id === oldStr);
    if (!job) {
      const existing = jobs.find((j) => j.id === newStr);
      if (existing) return newStr;
      return newStr;
    }

    // Se já existe um com newStr, mescla sem permitir que um snapshot
    // terminal/stale (ex.: 100% com 0/0) contamine o job local recém-criado.
    const dup = jobs.find((j) => j.id === newStr);
    if (dup && dup !== job) {
      const dupZeroWorkTerminal =
        !!dup.completed &&
        Number(dup.processed || 0) === 0 &&
        Number(dup.total || 0) === 0;
      const incomingLooksLive =
        !job.completed &&
        (isActiveState(job.state) || isWaitingState(job.state) || Number(job.progress || 0) === 0);
      const preferIncomingLiveState = dupZeroWorkTerminal && incomingLooksLive;

      dup.title = job.title || dup.title;
      if (preferIncomingLiveState) {
        dup.progress = clamp(job.progress || 0);
        dup.completed = false;
        dup.locked = false;
        dup.completedAt = 0;
        dup.state = job.state || "aguardando";
        dup.processed = Number.isFinite(Number(job.processed)) ? Number(job.processed) : 0;
        dup.total = Number.isFinite(Number(job.total)) ? Number(job.total) : dup.total;
        dup.success = Number.isFinite(Number(job.success)) ? Number(job.success) : 0;
        dup.errors = Number.isFinite(Number(job.errors)) ? Number(job.errors) : 0;
        dup.error = null;
        dup.failedReason = null;
      } else {
        dup.progress = Math.max(dup.progress || 0, job.progress || 0);
        dup.completed = dup.completed || job.completed;
        dup.locked = dup.locked || job.locked;
        dup.state = dup.state || job.state;
      }
      dup.dismissed = dup.dismissed || job.dismissed || dismissedJobIds.has(newStr);
      dup.sortOrder = Math.max(
        Number(dup.sortOrder || 0),
        Number(job.sortOrder || 0),
      );
      dup.completedAt = Math.max(
        Number(dup.completedAt || 0),
        Number(job.completedAt || 0),
      );
      dup.updated = Math.max(
        Number(dup.updated || 0),
        Number(job.updated || 0),
      );
      dup.adapter = dup.adapter || job.adapter || defaultAdapter;
      dup.backendJobId = dup.backendJobId || newIdentity.backendJobId || job.backendJobId;
      const existingSource = String(dup.source || "").trim();
      const incomingSource = String(job.source || "").trim();
      dup.source =
        existingSource && !/^(api|local)$/i.test(existingSource)
          ? existingSource
          : incomingSource && !/^(api|local)$/i.test(incomingSource)
            ? incomingSource
            : existingSource === "api" || incomingSource === "api"
              ? "api"
              : "local";
      jobs = jobs.filter((j) => j !== job);
      render();
      return newStr;
    }

    job.id = newStr;
    job.backendJobId = newIdentity.backendJobId;
    job.dismissed = job.dismissed || dismissedJobIds.has(newStr);
    if (!job.updated) job.updated = Date.now();
    render();
    return newStr;
  }

  function normalizeApiJob(adapterName, raw) {
    if (window.JobsPanelAdapters?.normalize) {
      return window.JobsPanelAdapters.normalize(adapterName, raw);
    }

    const processed = Number(raw?.processed ?? raw?.done ?? raw?.ok ?? raw?.count_ok ?? NaN);
    const success = Number(raw?.success ?? raw?.succeeded ?? raw?.count_ok ?? NaN);
    const total = Number(raw?.total ?? raw?.expected_total ?? raw?.count_total ?? NaN);
    const errors = Number(raw?.errors ?? raw?.error_count ?? raw?.failed ?? 0);
    const stateBase = normalizeStateText(raw?.state || raw?.status || raw?.result || "");
    const active = isActiveState(stateBase);
    const waiting = isWaitingState(stateBase);
    const failedFromState = isTerminalFailed(stateBase);
    const completedFromState = isTerminalCompleted(stateBase);
    const hasExplicitCompletion = typeof raw?.completed === "boolean";
    const completedFromExplicit = raw?.completed === true;
    const completed = completedFromExplicit || (!hasExplicitCompletion && completedFromState);
    let progress = Number(raw?.progress ?? raw?.pct ?? NaN);
    if (!Number.isFinite(progress) && Number.isFinite(processed) && total > 0) {
      progress = Math.round((processed / total) * 100);
    }
    progress = clamp(progress);
    const reviewAction = sanitizeReviewAction(
      raw?.review_action ||
      (raw?.download_csv_url
        ? { label: errors > 0 ? "Ver e corrigir" : "Baixar CSV", url: raw.download_csv_url }
        : null),
    );

    const backendJobId = String(
      raw?.backend_job_id || raw?.id || raw?.job_id || raw?.process_id || "",
    ).trim();
    const identity = normalizePanelIdentity(
      raw?.job_uid || backendJobId,
      adapterName,
      backendJobId,
    );
    return {
      adapter: adapterName,
      id: identity.uid,
      backendJobId: identity.backendJobId,
      title: raw?.title || raw?.label || raw?.name || raw?.job_name || "Processo",
      processed,
      success,
      total,
      errors,
      hasErrors: Number.isFinite(errors) && errors > 0,
      progress,
      stateBase,
      displayState: stateBase || `${progress}%`,
      active,
      waiting,
      completed,
      failed: (!completed && failedFromState) || (completed && errors > 0),
      hasExplicitCompletion,
      completedFromExplicit,
      completedFromState: !hasExplicitCompletion && completedFromState,
      completedFromCounts: false,
      completedFromProgress: false,
      failedFromState,
      accountKey: raw?.account?.key || raw?.accountKey || null,
      accountLabel: raw?.account?.label || raw?.accountLabel || null,
      updatedAt: raw?.updated_at ?? raw?.updatedAt ?? raw?.ts ?? raw?.timestamp,
      reviewAction,
      resumable: raw?.resumable === true,
      pending: Number(raw?.pending ?? Math.max(0, total - processed)),
      resumeUrl: raw?.resume_url || raw?.resumeUrl || null,
      fullReportUrl: raw?.full_report_url || raw?.fullReportUrl || null,
      error: raw?.error || raw?.failedReason || raw?.failed_reason || raw?.message || "",
    };
  }

  // Integra jobs vindos do backend
  function mergeApiJobs(list, options = {}) {
    if (!Array.isArray(list)) return;
    const requestedAdapter = String(options.adapter || defaultAdapter || "generic");

    // Defesa adicional: o backend ja canonicaliza IDs, mas durante deploys ou
    // transicoes do Bull uma resposta antiga pode trazer o mesmo job duas vezes.
    // Nunca deixamos um registro terminal sobrescrever um registro ativo do
    // mesmo ID dentro do mesmo poll.
    const apiById = new Map();
    for (const raw of list) {
      const adapterName = String(raw?.adapter || requestedAdapter || "generic");
      const normalized = normalizeApiJob(adapterName, raw);
      const id = String(normalized?.id || raw?.id || raw?.job_id || raw?.process_id || "").trim();
      if (!id) continue;
      const current = apiById.get(id);
      if (!current) {
        apiById.set(id, raw);
        continue;
      }
      const currentNorm = normalizeApiJob(adapterName, current);
      const incomingActive = !!normalized?.active || !!normalized?.waiting;
      const currentActive = !!currentNorm?.active || !!currentNorm?.waiting;
      const incomingTerminal = !!normalized?.completed || !!normalized?.failed;
      const currentTerminal = !!currentNorm?.completed || !!currentNorm?.failed;

      if (incomingActive && currentTerminal) {
        apiById.set(id, raw);
        continue;
      }
      if (currentActive && incomingTerminal) continue;

      const incomingUpdated = normalizeTimestamp(normalized?.updatedAt, 0);
      const currentUpdated = normalizeTimestamp(currentNorm?.updatedAt, 0);
      const incomingProcessed = Number(normalized?.processed || 0);
      const currentProcessed = Number(currentNorm?.processed || 0);
      if (
        incomingUpdated > currentUpdated ||
        (incomingUpdated === currentUpdated && incomingProcessed >= currentProcessed)
      ) {
        apiById.set(id, raw);
      }
    }
    const apiList = [...apiById.values()];

    const incomingIds = new Set(
      apiList
        .map((raw) => {
          const adapterName = String(raw?.adapter || requestedAdapter || "generic");
          return String(normalizeApiJob(adapterName, raw)?.id || "").trim();
        })
        .filter(Boolean),
    );
    const isFiltroPanelTitle = (value) => {
      const title = String(value || "").trim().toLowerCase();
      return (
        title.startsWith("filtro de anuncios") ||
        title.startsWith("exportacao csv") ||
        title.startsWith("exportação csv")
      );
    };
    const incomingFiltroJobs = apiList
      .map((raw) => {
        const title = String(raw?.title || raw?.label || raw?.name || raw?.job_name || "")
          .trim()
          .toLowerCase();
        if (!isFiltroPanelTitle(title)) return null;
        const accountKey =
          raw?.account?.key ||
          (raw?.account?.meli_conta_id != null ? String(raw.account.meli_conta_id) : null) ||
          (raw?.account?.meliContaId != null ? String(raw.account.meliContaId) : null) ||
          (raw?.accountKey != null ? String(raw.accountKey) : null) ||
          null;
        const accountLabel = raw?.account?.label || raw?.accountLabel || null;
        return {
          accountKey: String(accountKey || "").trim().toLowerCase(),
          accountLabel: String(accountLabel || "").trim().toLowerCase(),
        };
      })
      .filter(Boolean);

    if (incomingFiltroJobs.length) {
      jobs = jobs.filter((job) => {
        const id = String(job?.id || "").trim();
        if (incomingIds.has(id)) return true;
        const title = String(job?.title || "").trim().toLowerCase();
        if (!isFiltroPanelTitle(title)) return true;
        if (job.completed || job.reviewAction?.url) return true;
        const progress = Number(job.progress || 0);
        const state = String(job.state || "").toLowerCase();
        const looksStuck = progress >= 100 || /processando\s+100%/.test(state);
        if (!looksStuck) return true;
        const accountKey = String(job.accountKey || "").trim().toLowerCase();
        const accountLabel = String(job.accountLabel || "").trim().toLowerCase();
        return !incomingFiltroJobs.some((incoming) => {
          if (incoming.accountKey && accountKey) return incoming.accountKey === accountKey;
          if (incoming.accountLabel && accountLabel) return incoming.accountLabel === accountLabel;
          return !incoming.accountKey && !incoming.accountLabel;
        });
      });
    }

    apiList.forEach((raw) => {
      const adapterName = String(raw?.adapter || requestedAdapter || "generic");
      const normalized = normalizeApiJob(adapterName, raw);
      const id = String(normalized?.id || raw.id || raw.job_id || raw.process_id || "").trim();
      if (!id) return;
      const title = normalized?.title || raw.title || raw.label || "Processo";
      const processed = Number(normalized?.processed ?? NaN);
      const success = Number(normalized?.success ?? NaN);
      const total = Number(normalized?.total ?? NaN);
      const progress = clamp(normalized?.progress ?? raw.progress ?? 0);
      const stateBase = normalizeStateText(normalized?.stateBase || raw.state || raw.status || "");
      const state = normalizeStateText(normalized?.displayState || stateBase || `${progress}%`);
      const errors = Number(normalized?.errors ?? 0);
      const hasErrors = !!normalized?.hasErrors;
      const hasExplicitCompletion = !!normalized?.hasExplicitCompletion;
      const completedFromRaw = !!normalized?.completedFromExplicit;
      const completedFromState = !!normalized?.completedFromState;
      const completedFromCounts = !!normalized?.completedFromCounts;
      const completedFromProgress = !!normalized?.completedFromProgress;
      const failedFromState = !!normalized?.failedFromState;
      const waitingState = !!normalized?.waiting;
      const activeState = !!normalized?.active;
      const isCompleted = !!normalized?.completed;
      const isFailed = !!normalized?.failed;
      const accountKey = normalized?.accountKey || null;
      const accountLabel = normalized?.accountLabel || null;
      const backendUpdatedAt = normalizeTimestamp(normalized?.updatedAt, 0);
      const reviewAction = sanitizeReviewAction(normalized?.reviewAction);

      const job = ensureJob(id, adapterName, normalized?.backendJobId);
      if (!job) return;
      job.adapter = adapterName;
      job.backendJobId = normalized?.backendJobId || job.backendJobId || id;
      const apiSource = String(
        normalized?.source || raw?.source || raw?.job_source || raw?.source_key || raw?.jobSource || "",
      ).trim();
      job.source = apiSource || "api";
      job.resumable = normalized?.resumable === true;
      job.pending = Number(normalized?.pending ?? 0);
      job.resumeUrl = normalized?.resumeUrl || null;
      job.fullReportUrl = normalized?.fullReportUrl || null;
      job.safetyPaused = normalized?.safetyPaused === true;
      job.retryWait = normalized?.retryWait === true;
      job.cancelRequested = normalized?.cancelRequested === true;
      job.canCancel = normalized?.canCancel !== false;
      job.retryAt = normalized?.retryAt || null;
      job.retryAttempt = normalized?.retryAttempt;
      job.retryMaxAttempts = normalized?.retryMaxAttempts;
      job.retryReason = normalized?.retryReason || "";
      job.operationId = normalized?.operationId || null;
      job.remediationTotal = Number(normalized?.remediationTotal || 0);
      job.remediationPending = Number(normalized?.remediationPending || 0);
      job.remediationResolved = Number(normalized?.remediationResolved || 0);
      job.remediationCritical = Number(normalized?.remediationCritical || 0);
      job.queuePosition = normalized?.queuePosition;
      job.queueWaitSeconds = Number(normalized?.queueWaitSeconds || 0);
      job.queueReason = normalized?.queueReason || "";
      job.workerStatus = normalized?.workerStatus || "";
      job.workerLastSeen = normalized?.workerLastSeen || null;
      job.workerDelayed = normalized?.workerDelayed === true;
      job.stalledWarning = normalized?.stalledWarning === true;
      job.itemsPerMinute = normalized?.itemsPerMinute;
      job.etaSeconds = normalized?.etaSeconds;
      job.itemConcurrency = normalized?.itemConcurrency;
      job.itemConcurrencyMax = normalized?.itemConcurrencyMax;
      job.lastItemDurationMs = normalized?.lastItemDurationMs;
      if (job.dismissed || dismissedJobIds.has(id)) {
        job.dismissed = true;
        return;
      }

      const backendAuthoritativelyRunning =
        adapterName === "promocoes" &&
        !isCompleted &&
        !isFailed &&
        (activeState || waitingState || normalized?.retryWait === true || normalized?.canceling === true);
      const recoverPrematureCompletion =
        (isPrematureDownloadError(job) || backendAuthoritativelyRunning) &&
        !completedFromRaw &&
        !completedFromState &&
        (waitingState || activeState || progress < 100 || processed < total);
      const hadPrematureTerminalSnapshot =
        recoverPrematureCompletion ||
        (backendAuthoritativelyRunning &&
          (job.completed || job.locked ||
            (Number(job.progress || 0) >= 100 && Number.isFinite(processed) && Number.isFinite(total) && total > 0 && processed < total)));
      if (hadPrematureTerminalSnapshot) {
        job.completed = false;
        job.locked = false;
        job.completedAt = 0;
        job.error = null;
        job.failedReason = null;
        job.errors = Number.isFinite(errors) ? errors : 0;
        // O backend de promoções é a fonte de verdade. Se um snapshot antigo
        // marcou 100%/terminal antes do worker realmente iniciar, liberamos
        // explicitamente a regressao visual para a cobertura real (ex.: 3/39=8%).
        if (!normalized?.reviewAction) job.reviewAction = null;
      }

      // Para fontes não autoritativas, ainda preservamos o lock terminal.
      // Em promoções, estado ativo/queued vindo do backend deve sempre poder
      // recuperar um card que foi concluído prematuramente no navegador.
      if (
        (job.locked || job.completed) &&
        !isCompleted &&
        !isFailed &&
        !backendAuthoritativelyRunning
      ) {
        return;
      }

      if ((job.locked || job.completed) && !hasErrors && failedFromState) {
        return;
      }

      let changed = false;
      if (job.title !== title) {
        job.title = title;
        changed = true;
      }
      const coverageProgress =
        Number.isFinite(processed) && Number.isFinite(total) && total > 0
          ? clamp((processed / total) * 100)
          : progress;
      const nextProgress =
        backendAuthoritativelyRunning && hadPrematureTerminalSnapshot
          ? coverageProgress
          : monotonicProgress(job, progress, {
              terminal: isCompleted || isFailed,
            });
      if (nextProgress != null && job.progress !== nextProgress) {
        job.progress = nextProgress;
        changed = true;
      }
      if (Number.isFinite(processed)) {
        const nextProcessed = processed;
        if (job.processed !== nextProcessed) {
          job.processed = nextProcessed;
          changed = true;
        }
      }
      if (Number.isFinite(total) && job.total !== total) {
        job.total = total;
        changed = true;
      }
      if (Number.isFinite(errors) && job.errors !== errors) {
        job.errors = errors;
        changed = true;
      }
      const rawError = String(raw.error || raw.failedReason || raw.failed_reason || raw.message || "").trim();
      if (rawError && job.error !== rawError) {
        job.error = rawError;
        job.failedReason = rawError;
        changed = true;
      } else if (!rawError && !isCompleted && !isFailed && (job.error || job.failedReason)) {
        job.error = null;
        job.failedReason = null;
        changed = true;
      }
      if (Number.isFinite(success) && job.success !== success) {
        job.success = success;
        changed = true;
      }
      if (accountKey != null && job.accountKey !== accountKey) {
        job.accountKey = accountKey;
        changed = true;
      }
      if (accountLabel != null && job.accountLabel !== accountLabel) {
        job.accountLabel = accountLabel;
        changed = true;
      }
      if (
        (job.reviewAction?.label || null) !== (reviewAction?.label || null) ||
        (job.reviewAction?.url || null) !== (reviewAction?.url || null)
      ) {
        job.reviewAction = reviewAction;
        changed = true;
      }

      if (isCompleted) {
        if (!job.completed) changed = true;
        job.completed = true;
        const hasCoverage =
          Number.isFinite(processed) &&
          Number.isFinite(total) &&
          total > 0;
        const terminalProgress = hasCoverage
          ? clamp((processed / total) * 100)
          : progress;
        if (job.progress !== terminalProgress) changed = true;
        job.progress = terminalProgress;
        job.completedAt = Math.max(
          Number(job.completedAt || 0),
          Number(backendUpdatedAt || 0),
          Date.now(),
        );

        if (hasErrors) {
          job.state = `concluído com ${errors} erro(s)`;
          job.locked = true; // também é terminal
        } else {
          // se estado veio "failed" mas terminou sem erro, padroniza
          job.state =
            !stateBase ||
            failedFromState ||
            completedFromProgress ||
            /^(active|running|processing|processando|iniciando)\b/i.test(
              stateBase.toLowerCase()
            )
              ? "concluido"
              : stateBase;
          job.locked = true;
        }
      } else if (isFailed) {
        if (!job.completed) changed = true;
        job.completed = true; // terminal
        job.state = stateBase || "falhou";
        job.locked = true;
        job.completedAt = Math.max(
          Number(job.completedAt || 0),
          Number(backendUpdatedAt || 0),
          Date.now(),
        );
      } else {
        if (job.state !== state && !shouldKeepCurrentState(job, state, progress, processed)) {
          changed = true;
          job.state = state;
        }
      }

      if (backendUpdatedAt > Number(job.updated || 0)) {
        job.updated = backendUpdatedAt;
      } else if (changed) {
        job.updated = Date.now();
      }
    });

    show();
    render();
  }

  function show() {
    const root = ensurePanel();
    panelHidden = false;
    if (root) root.classList.remove("hidden");
  }

  function hide() {
    const root = ensurePanel();
    panelHidden = true;
    if (root) root.classList.add("hidden");
  }

  document.addEventListener("DOMContentLoaded", () => {
    const root = ensurePanel();
    if (!root) return;
    show();
    render();
  });

  window.JobsPanel = {
    addLocalJob,
    updateLocalJob,
    mergeApiJobs,
    replaceId,
    setCancelHandler(handler) {
      cancelHandler = typeof handler === "function" ? handler : null;
    },
    setVisibilityFilter(handler) {
      visibilityFilter = typeof handler === "function" ? handler : null;
      render();
    },
    setAdapter(name) {
      defaultAdapter = String(name || "generic");
    },
    hasRunningJobs,
    isJobVisible: isJobVisibleForCurrentScope,
    show,
    hide,
  };
})();

