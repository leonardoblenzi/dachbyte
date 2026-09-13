// =============================================================
// Base path helper (supports deployments under /ml)
// =============================================================
(function initBasePath() {
  if (typeof window === "undefined") return;
  if (window.__ML_BASE_PATH != null) return;
  const p = window.location && window.location.pathname ? window.location.pathname : "";
  window.__ML_BASE_PATH = p === "/ml" || p.startsWith("/ml/") ? "/ml" : "";
})();

function withBase(path) {
  const base =
    typeof window !== "undefined" && window.__ML_BASE_PATH ? window.__ML_BASE_PATH : "";
  if (!path || typeof path !== "string") return path;
  if (!base) return path;
  if (path === base || path.startsWith(base + "/")) return path;
  if (path.startsWith("/")) return base + path;
  return path;
}

(() => {
  const $ = (id) => document.getElementById(id);
  const qsa = (selector, el = document) => Array.from(el.querySelectorAll(selector));

  const API_CREATE_JOB = () => withBase("/api/validar-dimensoes/jobs");
  const API_JOB = (id) => withBase(`/api/validar-dimensoes/jobs/${encodeURIComponent(id)}`);
  const API_JOB_ITEMS = (id) =>
    withBase(`/api/validar-dimensoes/jobs/${encodeURIComponent(id)}/items`);
  const API_JOB_RESULTS = (id) =>
    withBase(`/api/validar-dimensoes/jobs/${encodeURIComponent(id)}/results`);
  const API_JOB_DOWNLOAD = (id) =>
    withBase(`/api/validar-dimensoes/jobs/${encodeURIComponent(id)}/download.csv`);

  const ACCOUNT_LABELS = {
    drossi: "DRossi Interiores",
    diplany: "Diplany",
    rossidecor: "Rossi Decor",
  };
  const DEFAULT_HELPER_TEXT = {
    consulta: "Consulte um anuncio, uma lista ou todos os ativos para entender o que ja existe antes de corrigir.",
    correcao: "Use a correção apenas quando a consulta ja mostrou falta ou erro real nas medidas.",
  };

  let resultados = [];
  let currentRows = [];
  let currentTotal = 0;
  let usesRemotePages = false;
  let currentPage = 1;
  let currentJobId = null;
  let jobsTimer = null;
  let jobsPanelTimer = null;
  let currentWorkspaceMode = "consulta";
  let currentAccountKey = "";
  let currentAccountLabel = "";
  let enqueueInFlight = false;
  const pageSize = 25;

  function isTerminalJobStateText(value) {
    const status = String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    return (
      /^conclu/.test(status) ||
      /^finaliz/.test(status) ||
      /^completed$/.test(status) ||
      /^done$/.test(status) ||
      /^success/.test(status) ||
      /^sucesso/.test(status) ||
      /^cancel/.test(status) ||
      /^abort/.test(status) ||
      /^falh/.test(status) ||
      /^failed/.test(status) ||
      /^error$/.test(status) ||
      /^erro$/.test(status) ||
      /^erro ao iniciar/.test(status)
    );
  }

  function normalizePanelJobText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function readShellAccountLabel() {
    const raw = String(document.getElementById("account-current")?.textContent || "").trim();
    if (!raw) return "";
    if (/carregando|indispon|nao selecionada|nenhuma selecionada/i.test(raw)) return "";
    return raw;
  }

  function currentValidarAccountScope() {
    const shellLabel = readShellAccountLabel();
    return {
      key: normalizePanelJobText(currentAccountKey || ""),
      label: normalizePanelJobText(shellLabel || currentAccountLabel || ""),
    };
  }

  function getDefaultHelperText(mode = currentWorkspaceMode) {
    return DEFAULT_HELPER_TEXT[mode] || DEFAULT_HELPER_TEXT.consulta;
  }

  function updateModePanels(mode) {
    currentWorkspaceMode = mode === "correcao" ? "correcao" : "consulta";
    qsa("[data-dim-mode]").forEach((button) => {
      const active = button.dataset.dimMode === currentWorkspaceMode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });
    qsa("[data-mode-panel]").forEach((panel) => {
      const active = panel.dataset.modePanel === currentWorkspaceMode;
      panel.classList.toggle("dim-workspace--active", active);
      panel.hidden = !active;
    });
    if (!(usesRemotePages ? currentTotal : resultados.length)) {
      updateHelperText(getDefaultHelperText(currentWorkspaceMode));
    }
  }

  function getSingleMlb(panel = "consulta") {
    const id =
      panel === "correcao" ? "dim-correcao-mlb-single" : "dim-consulta-mlb-single";
    return String($(id)?.value || "").trim();
  }

  function getBulkLines(panel = "consulta") {
    const id = panel === "correcao" ? "dim-correcao-mlb-bulk" : "dim-consulta-mlb-bulk";
    return parseBulkLines($(id)?.value || "");
  }

  function looksLikeValidarDimensoesJob(job) {
    const adapter = normalizePanelJobText(job?.adapter || job?.module || "");
    const id = normalizePanelJobText(job?.job_uid || job?.id || "");
    if (adapter === "validar-dimensoes" || id.startsWith("validar-dimensoes:")) return true;
    const title = normalizePanelJobText(job?.title || job?.label || job?.name || "");
    return title.startsWith("validar dimensoes");
  }

  function shouldShowValidarDimensoesPanelJob(job) {
    if (!looksLikeValidarDimensoesJob(job)) return false;

    const current = currentValidarAccountScope();
    const jobAccountKey = normalizePanelJobText(
      job?.accountKey || job?.account?.key || job?.account?.meli_conta_id || "",
    );
    const jobAccountLabel = normalizePanelJobText(
      job?.accountLabel || job?.account?.label || "",
    );

    if (!current.key && !current.label) return true;
    if (!jobAccountKey && !jobAccountLabel) return true;
    if (current.label && jobAccountLabel && current.label === jobAccountLabel) return true;
    if (current.key && jobAccountKey) return current.key === jobAccountKey;
    return false;
  }

  function applyValidarDimensoesPanelVisibilityFilter() {
    window.JobsPanel?.setAdapter?.("validar-dimensoes");
    window.JobsPanel?.setVisibilityFilter?.(shouldShowValidarDimensoesPanelJob);
  }

  function formatValue(value, suffix = "") {
    return value == null || value === "" ? "-" : `${value}${suffix}`;
  }

  function formatCompactDimensions(result) {
    return [
      `A ${formatValue(result.height_cm, " cm")}`,
      `L ${formatValue(result.width_cm, " cm")}`,
      `C ${formatValue(result.length_cm, " cm")}`,
      `P ${formatValue(result.weight_g, " g")}`,
    ].join(" | ");
  }

  function resolveOriginLabel(result) {
    if (result?.marketplace_origin) return String(result.marketplace_origin).toUpperCase();
    return String(result?.shipping_mode || "").trim().toLowerCase() === "me2" ? "ME2" : "ME1";
  }

  function sourceLabel(source) {
    if (source === "seller_package_attributes") return "Atributos do pacote";
    if (source === "shipping.dimensions") return "shipping.dimensions";
    return "Sem medida encontrada";
  }

  function shortStatusLabel(result) {
    if (isMarketplaceBlocked(result) && !result.updated) return "Bloqueado pelo ML";
    if (!result?.success || result?.status === "ERRO") return result?.message || "Erro";
    if (result?.updated) return result?.updated_message || "Atualizado";
    if (result?.has_dimensions_complete) return "Medidas completas";
    return "Medidas incompletas";
  }

  function observationLabel(result) {
    if (result?.updated && result?.debug_update?.overwrite_requested) {
      return "Sobrescrita manual aplicada.";
    }
    if (result?.debug_update?.fill_source === "item_attributes") {
      return "Auto update montado pelo proprio anuncio.";
    }
    if (result?.debug_update?.fill_source === "manual_form") {
      return "Preenchimento manual informado na lateral.";
    }
    if (result?.updated_message && !result?.updated) {
      return result.updated_message;
    }
    const missing = result?.debug_update?.auto_fill_details?.missing_fields;
    if (Array.isArray(missing) && missing.length) {
      return `Faltando: ${missing.join(", ")}`;
    }
    return result?.message || "-";
  }

  function hasApiCannotUpdateError(result) {
    return (
      !result?.success &&
      /cannot update item/i.test(String(result?.message || "")) &&
      (result?.has_bids === true || Number(result?.sold_quantity || 0) > 0)
    );
  }

  function isMarketplaceBlocked(result) {
    return (
      result?.ml_update_blocked === true ||
      result?.debug_update?.skipped_reason === "marketplace_restriction" ||
      hasApiCannotUpdateError(result)
    );
  }

  function buildStatusChip(result) {
    if (isMarketplaceBlocked(result) && !result.updated) {
      return '<span class="status-chip status-chip--error">Bloqueado pelo ML</span>';
    }
    if (!result?.success || result?.status === "ERRO") {
      return `<span class="status-chip status-chip--error">${escapeHtml(
        shortStatusLabel(result),
      )}</span>`;
    }
    if (result?.updated) {
      return `<span class="status-chip status-chip--warn">${escapeHtml(
        shortStatusLabel(result),
      )}</span>`;
    }
    return `<span class="status-chip status-chip--ok">${escapeHtml(shortStatusLabel(result))}</span>`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getFillDimensionsFromForm() {
    const height = $("dim-fill-height")?.value?.trim();
    const width = $("dim-fill-width")?.value?.trim();
    const length = $("dim-fill-length")?.value?.trim();
    const weight = $("dim-fill-weight")?.value?.trim();

    if (!height || !width || !length || !weight) {
      throw new Error(
        "Preencha altura, largura, comprimento e peso para usar o preenchimento manual.",
      );
    }

    return {
      height_cm: Number(height),
      width_cm: Number(width),
      length_cm: Number(length),
      weight_g: Number(weight),
    };
  }

  function getForceOverwriteFromForm() {
    return $("dim-force-overwrite")?.checked === true;
  }

  function getDelayMsForMode(mode) {
    return mode === "analyze" ? 0 : 300;
  }

  function buildRequestOptions(mode) {
    if (mode === "manual") {
      return {
        fillDimensions: getFillDimensionsFromForm(),
        forceOverwrite: getForceOverwriteFromForm(),
      };
    }
    if (mode === "auto") {
      return { autoFillFromItem: true };
    }
    return {};
  }

  function modeLabel(mode, source = "manual_list") {
    if (source === "active_items") return "Consultando todos os anuncios ativos";
    if (mode === "auto") return "Auto update pelo anuncio";
    if (mode === "manual") return "Preenchendo medidas";
    return "Analisando";
  }

  async function fetchJson(url, init) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    return payload;
  }

  async function carregarContaAtual() {
    const el = $("account-current");
    try {
      const data = await fetchJson(withBase("/api/account/current"), { cache: "no-store" });
      let shown = "Nao selecionada";
      let accountKey = null;

      if (data && (data.ok || data.success)) {
        accountKey = String(data.accountKey || data.current?.id || data.key || "").trim();
        currentAccountKey = accountKey;
        currentAccountLabel = String(
          data.label ||
            data.current?.label ||
            ACCOUNT_LABELS[data.accountKey] ||
            data.accountKey ||
            "",
        ).trim();
        shown = currentAccountLabel || currentAccountKey || "Desconhecida";
      } else if (data) {
        accountKey = String(data.accountKey || data.current?.id || data.key || "").trim();
        currentAccountKey = accountKey;
        currentAccountLabel = String(data.label || data.current?.label || data.accountKey || "").trim();
        shown = currentAccountLabel || currentAccountKey || "Desconhecida";
      }

      window.__ACCOUNT__ = {
        ...(window.__ACCOUNT__ || {}),
        key: currentAccountKey || null,
        accountKey: currentAccountKey || null,
        meli_conta_id: currentAccountKey || null,
        label: currentAccountLabel || null,
      };
      if (el) el.textContent = shown;
      applyValidarDimensoesPanelVisibilityFilter();
      syncJobsPanel().catch(console.error);
    } catch {
      if (el) el.textContent = "Indisponivel";
      applyValidarDimensoesPanelVisibilityFilter();
    }
  }

  async function trocarConta() {
    const to = window.mlUrl ? window.mlUrl : withBase;
    try {
      await fetch(to("/api/account/clear"), { method: "POST" });
    } catch {}
    window.location.href = to("/select-conta");
  }

  function notify(message, mode = "info") {
    const prefix = mode === "error" ? "Erro" : mode === "success" ? "OK" : "Info";
    updateHelperText(`${prefix}: ${message}`);
  }

  function updateHelperText(text) {
    const helper = $("dim-ml-alert-summary");
    if (helper) helper.textContent = text;
  }

  async function fetchDimensoes(mlb, options = {}) {
    const json = await fetchJson(withBase("/api/validar-dimensoes/analisar-item"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mlb,
        ...(options.fillDimensions ? { fill_dimensions: options.fillDimensions } : {}),
        ...(options.forceOverwrite ? { force_overwrite: true } : {}),
        ...(options.autoFillFromItem ? { autofill_from_item: true } : {}),
      }),
    });
    return json.data || {};
  }

  function getPageItems() {
    if (usesRemotePages) return currentRows.slice();
    const start = (currentPage - 1) * pageSize;
    return resultados.slice(start, start + pageSize);
  }

  function updatePaginationControls() {
    const totalItems = usesRemotePages ? currentTotal : resultados.length;
    const totalPages = Math.ceil(totalItems / pageSize) || 1;
    const lbl = $("dim-page-label");
    const btnPrev = $("dim-page-prev");
    const btnNext = $("dim-page-next");

    if (lbl) lbl.textContent = `Pagina ${currentPage} de ${totalPages}`;
    if (btnPrev) btnPrev.disabled = currentPage <= 1;
    if (btnNext) btnNext.disabled = currentPage >= totalPages;
  }

  function updateResultSummary() {
    const sourceRows = usesRemotePages ? currentRows : resultados;
    const totalItems = usesRemotePages ? currentTotal : resultados.length;
    if (!sourceRows.length && !totalItems) {
      updateHelperText(getDefaultHelperText());
      return;
    }

    const completeCount = sourceRows.filter((result) => result?.has_dimensions_complete).length;
    const blockedCount = sourceRows.filter((result) => isMarketplaceBlocked(result)).length;
    const errorCount = sourceRows.filter((result) => !result?.success).length;
    const summaryPrefix = usesRemotePages
      ? `${totalItems} item(ns) no job | pagina ${currentPage}`
      : `${resultados.length} item(ns) consultado(s)`;

    const parts = [
      summaryPrefix,
      `${completeCount} com medidas completas nesta pagina`,
    ];
    if (blockedCount) parts.push(`${blockedCount} com bloqueio do ML nesta pagina`);
    if (errorCount) parts.push(`${errorCount} com erro nesta pagina`);

    updateHelperText(parts.join(" | "));
  }

  function renderTabela() {
    const tbody = $("dim-results-body");
    const btnDownload = $("btn-dim-download");
    if (!tbody || !btnDownload) return;

    const pageItems = getPageItems();
    const totalItems = usesRemotePages ? currentTotal : resultados.length;
    if (!totalItems || !pageItems.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="table-empty">Sem resultados ainda</td></tr>';
      btnDownload.disabled = !currentJobId;
      updatePaginationControls();
      updateResultSummary();
      return;
    }

    tbody.innerHTML = pageItems
      .map(
        (result, index) => `
          <tr>
            <td>${Math.max(0, (currentPage - 1) * pageSize) + index + 1}</td>
            <td class="mono">${escapeHtml(result.mlb || "")}</td>
            <td>${escapeHtml(result.sku || "-")}</td>
            <td>${escapeHtml(resolveOriginLabel(result))}</td>
            <td>${escapeHtml(sourceLabel(result.dimensions_source))}</td>
            <td>${escapeHtml(formatCompactDimensions(result))}</td>
            <td>${buildStatusChip(result)}</td>
            <td>${escapeHtml(observationLabel(result))}</td>
          </tr>`,
      )
      .join("");

    btnDownload.disabled = !currentJobId;
    updatePaginationControls();
    updateResultSummary();
  }

  function atualizarProgresso(atual, total, currentMode = "Aguardando execucao") {
    void atual;
    void total;
    void currentMode;
  }

  function parseBulkLines(text) {
    return Array.from(
      new Set(
        String(text || "")
          .split(/\r?\n+/)
          .map((line) => line.trim().toUpperCase())
          .filter(Boolean),
      ),
    );
  }

  function isTerminalState(job) {
    return isTerminalJobStateText(job?.state || job?.status || "");
  }

  function isActiveJob(job) {
    if (!job) return false;
    if (job.completed === true) return false;
    return !isTerminalJobStateText(job.state || job.status || "");
  }

  function resolveDimensoesReviewAction(job, jobId, completed) {
    const explicit =
      job?.review_action && job.review_action.url
        ? {
            label: job.review_action.label || "Baixar CSV",
            url: job.review_action.url,
          }
        : null;
    if (explicit) return explicit;
    const directUrl = String(job?.download_csv_url || "").trim();
    if (directUrl) {
      return {
        label: Number(job?.errors || 0) > 0 ? "Ver e corrigir" : "Baixar CSV",
        url: directUrl,
      };
    }
    if (!completed) return null;
    return {
      label: Number(job?.errors || 0) > 0 ? "Ver e corrigir" : "Baixar CSV",
      url: API_JOB_DOWNLOAD(jobId),
    };
  }

  async function syncJobsPanel() {
    if (!window.JobsPanel?.mergeApiJobs) return [];
    try {
      const payload = await fetchJson(withBase("/api/validar-dimensoes/jobs"));
      const rawJobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
      const account = window.__ACCOUNT__ || {};
      const accountKey =
        currentAccountKey || account.key || account.accountKey || payload?.account?.key || null;
      const accountLabel =
        readShellAccountLabel() || currentAccountLabel || account.label || payload?.account?.label || null;
      const jobs = rawJobs.map((job) => ({
        ...job,
        title: job?.title || job?.label || "Validar dimensoes",
        account: {
          ...(job?.account || {}),
          key: job?.account?.key || job?.data?.accountKey || accountKey || null,
          meli_conta_id:
            job?.account?.meli_conta_id || job?.data?.accountKey || accountKey || null,
          label: accountLabel || job?.account?.label || null,
        },
        accountKey: job?.accountKey || job?.data?.accountKey || job?.account?.key || accountKey,
        accountLabel: accountLabel || job?.accountLabel || job?.account?.label || null,
      }));
      if (jobs.length) {
        window.JobsPanel?.show?.();
        window.JobsPanel?.mergeApiJobs?.(jobs);
        const activeJob = jobs.find(isActiveJob) || null;
        const currentJobStillExists =
          !!currentJobId && jobs.some((job) => String(job?.id || "") === currentJobId);
        if (!currentJobId || (!currentJobStillExists && activeJob?.id)) {
          currentJobId = activeJob?.id ? String(activeJob.id) : currentJobId;
        } else if (currentJobId && !currentJobStillExists) {
          currentJobId = null;
          stopJobsPolling();
        }
        if (currentJobId && !jobsTimer) {
          const activeCurrentJob = jobs.find((job) => String(job?.id || "") === currentJobId);
          if (activeCurrentJob && isActiveJob(activeCurrentJob)) {
            startJobsPolling();
          }
        }
      } else if (currentJobId) {
        currentJobId = null;
        stopJobsPolling();
      }
      return jobs;
    } catch (error) {
      console.warn("Falha ao sincronizar jobs de validar dimensoes:", error.message);
    }
    return [];
  }

  function stopJobsPanelSync() {
    if (jobsPanelTimer) clearInterval(jobsPanelTimer);
    jobsPanelTimer = null;
  }

  function startJobsPanelSync() {
    if (jobsPanelTimer) return;
    syncJobsPanel().catch(console.error);
    jobsPanelTimer = setInterval(() => {
      syncJobsPanel().catch(console.error);
    }, 5000);
  }

  async function waitForJobsPanel(timeoutMs = 1500) {
    const startedAt = Date.now();
    while (!window.JobsPanel?.addLocalJob && Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return window.JobsPanel || null;
  }

  async function cancelJobFromPanel(job) {
    if (!job?.id) return false;
    const cancelledJobId = String(job.id);
    const payload = await fetchJson(
      withBase(`/api/validar-dimensoes/jobs/${encodeURIComponent(job.backendJobId || job.id)}/cancel`),
      { method: "POST" },
    );
    const status = String(payload?.status || "");
    window.JobsPanel?.updateLocalJob?.(job.id, {
      state: /cancelando/i.test(status) ? "cancelando" : "cancelado",
      completed: !/cancelando/i.test(status),
      progress: /cancelando/i.test(status) ? job.progress || 0 : 100,
    });
    if (currentJobId === cancelledJobId && !/cancelando/i.test(status)) {
      currentJobId = null;
      stopJobsPolling();
      await syncJobsPanel();
    }
    return true;
  }

  async function loadJobPage(jobId, page = 1) {
    const safePage = Math.max(1, Number(page || 1) || 1);
    const payload = await fetchJson(
      `${API_JOB_ITEMS(jobId)}?page=${encodeURIComponent(safePage)}&limit=${encodeURIComponent(pageSize)}`,
      { cache: "no-store" },
    );
    currentPage = safePage;
    currentRows = Array.isArray(payload?.data) ? payload.data : [];
    currentTotal = Math.max(0, Number(payload?.total || 0) || 0);
    usesRemotePages = true;
    renderTabela();
  }

  async function loadCurrentJobResults(jobId) {
    try {
      await loadJobPage(jobId, 1);
    } catch (error) {
      const payload = await fetchJson(API_JOB_RESULTS(jobId), { cache: "no-store" });
      resultados = Array.isArray(payload?.results) ? payload.results : [];
      currentRows = [];
      currentTotal = resultados.length;
      usesRemotePages = false;
      currentPage = 1;
      renderTabela();
    }
  }

  async function pollCurrentJob() {
    if (!currentJobId) return;

    try {
      await syncJobsPanel();
      if (!currentJobId) return;
      const payload = await fetchJson(API_JOB(currentJobId), { cache: "no-store" });
      const job = payload?.job || null;
      if (!job) return;
      const completed = isTerminalState(job);
      const reviewAction = resolveDimensoesReviewAction(job, currentJobId, completed);

      atualizarProgresso(
        Number(job.processed || 0),
        Number(job.total || job.total_mlbs || 0),
        String(job.state || "processando"),
      );

      window.JobsPanel?.updateLocalJob?.(currentJobId, {
        title: "Validar dimensoes",
        progress: Number(job.progress ?? 0),
        processed: Number(job.processed ?? 0),
        total: Number(job.total ?? 0),
        errors: Number(job.errors ?? 0),
        state:
          job.state ||
          (completed
            ? Number(job.errors || 0) > 0
              ? `concluido com ${Number(job.errors || 0)} erro(s)`
              : "concluido"
            : `processando ${Number(job.processed || 0)}/${Number(job.total || 0)}`),
        completed,
        reviewAction,
        downloadCsvUrl: reviewAction?.url || null,
        accountKey: currentAccountKey || null,
        accountLabel: currentAccountLabel || readShellAccountLabel() || null,
      });

      if (completed) {
        await loadCurrentJobResults(currentJobId).catch(() => null);
        const stateLabel = String(job.state || "");
        if (/cancelado/i.test(stateLabel)) {
          notify("Job cancelado.", "error");
        } else if (/erro|failed/i.test(stateLabel)) {
          notify("Job finalizado com erro.", "error");
        } else {
          notify("Consulta finalizada. CSV liberado para download.", "success");
        }
        stopJobsPolling();
      }
    } catch (error) {
      if (/job nao encontrado|job n[aã]o encontrado|http 404/i.test(String(error?.message || ""))) {
        const missingJobId = currentJobId;
        const jobs = await syncJobsPanel().catch(() => []);
        const activeJob = Array.isArray(jobs) ? jobs.find(isActiveJob) : null;
        if (activeJob?.id && String(activeJob.id) !== String(missingJobId || "")) {
          currentJobId = String(activeJob.id);
          return;
        }
        currentJobId = null;
        stopJobsPolling();
        return;
      }
      console.warn("Falha ao consultar job atual de validar dimensoes:", error.message);
    }
  }

  function startJobsPolling() {
    stopJobsPolling();
    startJobsPanelSync();
    jobsTimer = setInterval(pollCurrentJob, 2500);
  }

  function stopJobsPolling() {
    if (jobsTimer) clearInterval(jobsTimer);
    jobsTimer = null;
  }

  function setBatchButtonsDisabled(disabled) {
    [
      "btn-dim-analisar-lote",
      "btn-dim-auto-lote",
      "btn-dim-preencher-lote",
      "btn-dim-analisar-ativos",
    ].forEach((id) => {
      const button = $(id);
      if (button) button.disabled = !!disabled;
    });
  }

  async function enqueueBatchJob(mlbs, mode, source = "manual_list", panel = "consulta") {
    if (enqueueInFlight) {
      notify("Ja existe uma criacao de job em andamento. Aguarde alguns segundos.", "info");
      return;
    }
    enqueueInFlight = true;
    setBatchButtonsDisabled(true);
    let localJobId = null;
    let jobsPanel = null;

    try {
      const options = buildRequestOptions(mode);
      const totalHint = source === "active_items" ? 0 : mlbs.length;
      const account = window.__ACCOUNT__ || {};
      const accountKey = currentAccountKey || account.key || account.accountKey || null;
      const accountLabel = readShellAccountLabel() || currentAccountLabel || account.label || null;
      jobsPanel = await waitForJobsPanel();

      notify("Criando job...", "info");
      atualizarProgresso(0, totalHint, modeLabel(mode, source));
      jobsPanel?.show?.();
      localJobId =
        jobsPanel?.addLocalJob?.({
        title:
          source === "active_items"
            ? "Validar dimensoes - ativos da conta"
            : `Validar dimensoes - ${mlbs.length} item(ns)`,
        accountKey,
        accountLabel,
        state:
          source === "active_items"
            ? "obtendo anuncios da conta"
            : `na fila 0/${mlbs.length}`,
        progress: 0,
      }) || null;

      const payload = await fetchJson(API_CREATE_JOB(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mlbs,
          mode,
          source,
          delay_ms: getDelayMsForMode(mode),
          ...(options.fillDimensions ? { fill_dimensions: options.fillDimensions } : {}),
          ...(options.forceOverwrite ? { force_overwrite: true } : {}),
        }),
      });

      currentJobId = String(payload?.job_id || "");
      if (localJobId && currentJobId) {
        jobsPanel?.replaceId?.(localJobId, currentJobId);
        jobsPanel?.updateLocalJob?.(currentJobId, {
          state:
            source === "active_items"
              ? "obtendo anuncios da conta"
              : `na fila 0/${mlbs.length}`,
          progress: 0,
          processed: 0,
          total: totalHint,
          accountKey,
          accountLabel,
        });
      }
      resultados = [];
      currentRows = [];
      currentTotal = 0;
      usesRemotePages = true;
      currentPage = 1;
      renderTabela();
      startJobsPolling();
      await syncJobsPanel();
    } catch (error) {
      if (localJobId) {
        jobsPanel?.updateLocalJob?.(localJobId, {
          progress: 100,
          state: "erro ao iniciar",
          completed: true,
        });
      }
      notify(error.message, "error");
    } finally {
      enqueueInFlight = false;
      setBatchButtonsDisabled(false);
    }
  }

  function exportarCSV() {
    if (!currentJobId) {
      notify("Nao ha job concluido para exportar.", "info");
      return;
    }
    window.location.href = API_JOB_DOWNLOAD(currentJobId);
  }

  async function executarUnitario(mode, panel = "consulta") {
    const mlb = getSingleMlb(panel);
    if (!mlb) {
      notify("Informe um MLB para executar a consulta unitaria.", "error");
      return;
    }

    stopJobsPolling();
    currentJobId = null;
    resultados = [];
    currentRows = [];
    currentTotal = 0;
    usesRemotePages = false;
    currentPage = 1;
    atualizarProgresso(0, 1, modeLabel(mode));

    try {
      const options = buildRequestOptions(mode);
      const result = await fetchDimensoes(mlb, options);
      resultados.push(result);
      currentTotal = resultados.length;
    } catch (error) {
      resultados = [
        {
          mlb,
          sku: null,
          marketplace_origin: "-",
          success: false,
          status: "ERRO",
          message: error.message,
          dimensions_source: "none",
          height_cm: null,
          width_cm: null,
          length_cm: null,
          weight_g: null,
        },
      ];
      currentTotal = resultados.length;
    }

    renderTabela();
    atualizarProgresso(1, 1, "Consulta concluida");
    notify("Consulta unitaria finalizada.", "success");
  }

  function bindEvents() {
    qsa("[data-dim-mode]").forEach((button) =>
      button.addEventListener("click", () => updateModePanels(button.dataset.dimMode || "consulta")),
    );

    $("btn-dim-analisar-um")?.addEventListener("click", () => executarUnitario("analyze", "consulta"));
    $("btn-dim-auto-um")?.addEventListener("click", () => executarUnitario("auto", "correcao"));
    $("btn-dim-preencher-um")?.addEventListener("click", () => executarUnitario("manual", "correcao"));

    $("btn-dim-analisar-lote")?.addEventListener("click", async () => {
      const mlbs = getBulkLines("consulta");
      if (!mlbs.length) {
        notify("Cole pelo menos um MLB para consultar em lote.", "error");
        return;
      }
      await enqueueBatchJob(mlbs, "analyze", "manual_list", "consulta");
    });

    $("btn-dim-auto-lote")?.addEventListener("click", async () => {
      const mlbs = getBulkLines("correcao");
      if (!mlbs.length) {
        notify("Cole pelo menos um MLB para executar o auto update em lote.", "error");
        return;
      }
      await enqueueBatchJob(mlbs, "auto", "manual_list", "correcao");
    });

    $("btn-dim-preencher-lote")?.addEventListener("click", async () => {
      const mlbs = getBulkLines("correcao");
      if (!mlbs.length) {
        notify("Cole pelo menos um MLB para preencher medidas em lote.", "error");
        return;
      }
      await enqueueBatchJob(mlbs, "manual", "manual_list", "correcao");
    });

    $("btn-dim-analisar-ativos")?.addEventListener("click", async () => {
      await enqueueBatchJob([], "analyze", "active_items", "consulta");
    });

    $("btn-dim-download")?.addEventListener("click", exportarCSV);

    $("dim-page-prev")?.addEventListener("click", () => {
      if (currentPage > 1) {
        const nextPage = currentPage - 1;
        if (usesRemotePages && currentJobId) {
          loadJobPage(currentJobId, nextPage).catch((error) => notify(error.message, "error"));
          return;
        }
        currentPage = nextPage;
        renderTabela();
      }
    });

    $("dim-page-next")?.addEventListener("click", () => {
      const totalItems = usesRemotePages ? currentTotal : resultados.length;
      const totalPages = Math.ceil(totalItems / pageSize) || 1;
      if (currentPage < totalPages) {
        const nextPage = currentPage + 1;
        if (usesRemotePages && currentJobId) {
          loadJobPage(currentJobId, nextPage).catch((error) => notify(error.message, "error"));
          return;
        }
        currentPage = nextPage;
        renderTabela();
      }
    });


    $("account-switch")?.addEventListener("click", trocarConta);

  }

  document.addEventListener("DOMContentLoaded", () => {
    carregarContaAtual();
    bindEvents();
    updateModePanels("consulta");
    renderTabela();
    updatePaginationControls();
    atualizarProgresso(0, 0);
    updateHelperText(getDefaultHelperText("consulta"));
    applyValidarDimensoesPanelVisibilityFilter();
    window.JobsPanel?.setCancelHandler?.(cancelJobFromPanel);
    startJobsPanelSync();
  });

  window.addEventListener("beforeunload", () => {
    stopJobsPolling();
    stopJobsPanelSync();
  });
})();
