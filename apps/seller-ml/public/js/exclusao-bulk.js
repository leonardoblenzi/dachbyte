/* exclusao-bulk.js
 * Fila para exclusão de anúncios utilizando o backend atual (COM PREFIXO /api/excluir-anuncio):
 *   - POST /api/excluir-anuncio/anuncios/excluir-lote
 *       -> { success, process_id }
 *   - GET  /api/excluir-anuncio/jobs
 *   - GET  /api/excluir-anuncio/jobs/:id
 *
 * Inclui "badge" (pill) com a conta ativa no JobsPanel.
 */
(function () {
  const QUEUE = [];
  const PANEL_JOB_PREFIX = "gestao-anuncios:";
  let running = false;
  let panelSyncTimer = null;

  function toPanelJobId(jobId) {
    const raw = String(jobId || "").trim();
    if (!raw || raw.startsWith("local-")) return raw;
    return raw.startsWith(PANEL_JOB_PREFIX) ? raw : `${PANEL_JOB_PREFIX}${raw}`;
  }

  function fromPanelJobId(jobId) {
    const value = String(jobId || "").trim();
    return value.startsWith(PANEL_JOB_PREFIX)
      ? value.slice(PANEL_JOB_PREFIX.length)
      : value;
  }

  function normalizePanelJobText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isTerminalJobStateText(value) {
    const status = normalizePanelJobText(value);
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

  function looksLikeExclusaoJob(job) {
    const adapter = normalizePanelJobText(job?.adapter || job?.module || "");
    const id = normalizePanelJobText(job?.job_uid || job?.id || "");
    if (adapter === "gestao-anuncios" || id.startsWith("gestao-anuncios:")) return true;
    const title = normalizePanelJobText(job?.title || "");
    return (
      title.includes("gestao") ||
      title.includes("exclus") ||
      title.includes("ativacao") ||
      title.includes("ativar") ||
      title.includes("pausa") ||
      title.includes("pausar") ||
      title.includes("encerramento") ||
      title.includes("encerrar")
    );
  }

  function applyExclusaoPanelVisibilityFilter() {
    window.JobsPanel?.setAdapter?.("gestao-anuncios");
    window.JobsPanel?.setVisibilityFilter?.((job) => looksLikeExclusaoJob(job));
  }

  // Base path helper (ex.: app montado em /ml)
  const __APP_BASE__ =
    window.__APP_BASE_PATH__ ||
    ((location.pathname || '').startsWith('/ml/') || (location.pathname || '') === '/ml'
      ? '/ml'
      : '');

  function withBase(path) {
    if (!__APP_BASE__) return path;
    if (!path) return __APP_BASE__;
    return path.startsWith('/') ? __APP_BASE__ + path : __APP_BASE__ + '/' + path;
  }

  // ✅ Prefixo correto da feature (roteado em index.js via app.use('/api/excluir-anuncio', ...))
  const API_BASE = withBase("/api/excluir-anuncio");
  const api = (p) => API_BASE + (p.startsWith("/") ? p : "/" + p);
  const jobDownloadCsvUrl = (id) =>
    api(`/jobs/${encodeURIComponent(String(id || "").trim())}/download.csv`);

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function mapAccountBadge(key, label) {
    const k = String(key || "").toLowerCase();
    if (k === "drossi") {
      return {
        key: String(key || "drossi"),
        label: label || "Drossi",
        text: label || "Drossi",
        cls: "badge-drossi",
      };
    }
    if (k === "diplany")
      return {
        key: String(key || "diplany"),
        label: label || "Diplany",
        text: label || "Diplany",
        cls: "badge-diplany",
      };
    if (k === "rossidecor")
      return {
        key: String(key || "rossidecor"),
        label: label || "Rossi Decor",
        text: label || "Rossi Decor",
        cls: "badge-rossidecor",
      };
    return {
      key: key ? String(key) : null,
      label: label || key || "Conta",
      text: label || key || "Conta",
      cls: "badge-default",
    };
  }

  async function getAccountBadge() {
    try {
      const ensuredAccount = await window.AccountBar?.ensure?.();
      if (ensuredAccount?.key) {
        return mapAccountBadge(ensuredAccount.key, ensuredAccount.label);
      }

      if (window.__ACCOUNT__?.key) {
        const shellLabel = String(document.getElementById("account-current")?.textContent || "").trim();
        return mapAccountBadge(
          window.__ACCOUNT__.key,
          shellLabel || window.__ACCOUNT__.label
        );
      }

      // Mantém como estava (se essa rota existir no seu projeto)
      const r = await fetch(withBase("/api/account/current"), {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });

      const j = await r.json().catch(() => ({}));
      const key =
        j.accountKey ||
        j.key ||
        j.current?.id ||
        j.current?.meli_conta_id ||
        null;
      const label = j.label || j.current?.label || key || "Conta";
      return mapAccountBadge(key, label);
    } catch {
      return { text: "Conta", cls: "badge-default" };
    }
  }

  async function startJob(entry) {
    const badge = await getAccountBadge();

    const tempId = JobsPanel.addLocalJob({
      title: entry.title || `Gestao de anuncios - ${entry.items.length} itens`,
      accountKey: badge.key || null,
      accountLabel: badge.label || badge.text,
    });

    let backendJobId = null;
    let panelJobId = tempId;

    try {
      // ✅ Endpoint correto (com prefixo /api/excluir-anuncio)
      const resp = await fetch(api("/anuncios/operacoes-lote"), {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          mlb_ids: entry.items,
          operation: entry.operation || "DELETE",
          delay_ms: entry.delayMs ?? 250,
        }),
      });

      const data = await resp.json().catch(() => ({}));

      if (!resp.ok || !data.success || !data.process_id) {
        JobsPanel.updateLocalJob(panelJobId, {
          progress: 100,
          state: "erro ao iniciar",
          completed: true,
        });
        return;
      }

      backendJobId = String(data.process_id);
      panelJobId = toPanelJobId(backendJobId);
      JobsPanel.replaceId?.(tempId, panelJobId);
      const responseAccountKey = data?.account?.key || badge.key || null;
      const responseAccountLabel = data?.account?.label || badge.label || badge.text || null;
      JobsPanel.updateLocalJob(panelJobId, {
        title: entry.title || `Gestao de anuncios - ${entry.items.length} itens`,
        state: "aguardando",
        progress: 0,
        processed: 0,
        total: entry.items.length,
        completed: false,
        accountKey: responseAccountKey,
        accountLabel: responseAccountLabel,
      });
      if (typeof entry.onJobCreated === "function") {
        try {
          entry.onJobCreated(panelJobId, {
            backendJobId,
            accountKey: responseAccountKey,
            accountLabel: responseAccountLabel,
          });
        } catch {}
      }
      startPanelSync();

      let done = false;
      while (!done) {
        await wait(2500);
        await syncJobsPanel();

        let st;
        try {
          const r = await fetch(api("/jobs/" + encodeURIComponent(backendJobId)), {
            cache: "no-store",
            credentials: "same-origin",
            headers: { Accept: "application/json" },
          });
          const data = await r.json();
          st = data?.job || null;
        } catch {
          st = null;
        }

        if (!st) continue;

        const pct = Number(st.progress ?? 0);
        const processed = Number(st.processed ?? 0);
        const total = Number(st.total ?? entry.items.length);
        const errors = Number(st.errors ?? st.failed ?? st.error_count ?? 0);
        const completed =
          st.completed === true ||
          isTerminalJobStateText(st.state || st.status || "");
        const stateText =
          st.state ||
          (completed
            ? "concluído"
            : `processando: ${processed || 0}/${total || entry.items.length}`);

        const reviewAction =
          st?.review_action && st.review_action.url
            ? {
                label: st.review_action.label || "Baixar CSV",
                url: st.review_action.url,
              }
            : null;
        const downloadCsvUrl =
          st?.download_csv_url ||
          (completed ? jobDownloadCsvUrl(backendJobId) : null);

        JobsPanel.updateLocalJob(panelJobId, {
          progress: Number.isFinite(pct) ? pct : 0,
          processed,
          total,
          errors,
          state: stateText,
          completed,
          reviewAction,
          downloadCsvUrl,
        });

        done = completed;
      }
    } catch (_e) {
      JobsPanel.updateLocalJob(panelJobId, {
        progress: 100,
        state: "falha inesperada",
        completed: true,
      });
    }
  }

  async function pump() {
    if (running) return;
    running = true;
    while (QUEUE.length) {
      const entry = QUEUE.shift();
      await startJob(entry);
    }
    running = false;
  }

  async function enqueue({ items, operation = "DELETE", delayMs = 250, title, onJobCreated }) {
    const list = (Array.isArray(items) ? items : [])
      .map((s) => String(s).trim())
      .filter(Boolean);

    if (!list.length) throw new Error("Nenhum MLB válido para enfileirar");

    QUEUE.push({ items: list, operation, delayMs, title, onJobCreated });
    pump();
  }

  async function syncJobsPanel() {
    try {
      const r = await fetch(api("/jobs"), {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && Array.isArray(data?.jobs)) {
        const panelJobs = data.jobs.map((job) => ({
          ...job,
          id: toPanelJobId(job?.id || job?.job_id || job?.process_id),
        }));
        window.JobsPanel?.mergeApiJobs?.(panelJobs);
        window.JobsPanel?.show?.();
        return panelJobs;
      }
    } catch {}
    return [];
  }

  function stopPanelSync() {
    if (panelSyncTimer) clearInterval(panelSyncTimer);
    panelSyncTimer = null;
  }

  function startPanelSync() {
    if (panelSyncTimer) return;
    const tick = () => syncJobsPanel().catch(() => []);
    tick();
    panelSyncTimer = setInterval(tick, 5000);
  }

  async function cancelJobFromPanel(job) {
    if (!job?.id) return false;
    const backendJobId = job.backendJobId || fromPanelJobId(job.id);
    const r = await fetch(api("/jobs/" + encodeURIComponent(backendJobId) + "/cancel"), {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data?.success === false) {
      throw new Error(data?.error || `HTTP ${r.status}`);
    }

    JobsPanel.updateLocalJob(job.id, {
      state: /cancelando/i.test(String(data?.status || "")) ? "cancelando" : "cancelado",
      completed: !/cancelando/i.test(String(data?.status || "")),
      progress: /cancelando/i.test(String(data?.status || "")) ? job.progress || 0 : 100,
    });
    return true;
  }

  applyExclusaoPanelVisibilityFilter();
  window.JobsPanel?.setCancelHandler?.(cancelJobFromPanel);
  startPanelSync();
  window.addEventListener("beforeunload", stopPanelSync);
  window.ExclusaoBulk = { enqueue };
})();
