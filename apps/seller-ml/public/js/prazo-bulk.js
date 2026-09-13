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

/* Fila para alteração de prazo (dias) usando o contrato padronizado de jobs.
   A criação ainda reaproveita o endpoint legado, mas o monitoramento usa
   /anuncios/jobs-prazo e /anuncios/jobs-prazo/:id.
*/
(function () {
  const QUEUE = [];
  let running = false;
  let currentProcessId = null;
  let panelSyncTimer = null;
  const API_CREATE = () => withBase("/anuncios/prazo-dias-lote");
  const API_JOBS = () => withBase("/anuncios/jobs-prazo");
  const API_JOB_DETAIL = (id) =>
    withBase(`/anuncios/jobs-prazo/${encodeURIComponent(id)}`);
  const API_JOB_DOWNLOAD = (id) =>
    withBase(`/anuncios/jobs-prazo/${encodeURIComponent(id)}/download.csv`);
  const API_JOB_CANCEL = (id) =>
    withBase(`/anuncios/jobs-prazo/${encodeURIComponent(id)}/cancel`);

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

  function looksLikePrazoJob(job) {
    const adapter = normalizePanelJobText(job?.adapter || job?.module || "");
    const id = normalizePanelJobText(job?.job_uid || job?.id || "");
    if (adapter === "prazo" || id.startsWith("prazo:")) return true;
    const title = normalizePanelJobText(job?.title || "");
    return title.includes("prazo");
  }

  function applyPrazoPanelVisibilityFilter() {
    window.JobsPanel?.setAdapter?.("prazo");
    window.JobsPanel?.setVisibilityFilter?.((job) => looksLikePrazoJob(job));
  }

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Mapeia conta -> classe CSS do badge
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
      if (window.__ACCOUNT__?.key) {
        const shellLabel = String(document.getElementById("account-current")?.textContent || "").trim();
        return mapAccountBadge(
          window.__ACCOUNT__.key,
          shellLabel || window.__ACCOUNT__.label
        );
      }
      const r = await fetch(withBase("/api/account/current"), { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      const key = j.accountKey || j.key || "default";
      const label = j.label || key;
      return mapAccountBadge(key, label);
    } catch {
      return { text: "Conta", cls: "badge-default" };
    }
  }

  async function startJob(entry) {
    const badge = await getAccountBadge();

    const tempId = JobsPanel.addLocalJob({
      title:
        entry.title ||
        `Prazo – ${entry.days} dia(s) • ${entry.items.length} itens`,
      accountKey: badge.key || null,
      accountLabel: badge.label || badge.text,
    });

    let jobId = tempId;

    try {
      const resp = await fetch(API_CREATE(), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mlb_ids: entry.items,
          days: entry.days,
          delay_ms: entry.delayMs ?? 250,
        }),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.success || !data.process_id) {
        JobsPanel.updateLocalJob(jobId, {
          progress: 100,
          state: "erro ao iniciar",
          completed: true,
        });
        return;
      }

      // troca o id temporário pelo process_id
      jobId = JobsPanel.replaceId(tempId, String(data.process_id));
      currentProcessId = String(data.process_id);
      if (typeof entry.onJobCreated === "function") {
        try {
          entry.onJobCreated(jobId, {
            accountKey: badge.key || null,
            accountLabel: badge.label || badge.text || null,
          });
        } catch {}
      }
      startPanelSync();

      // loop de status
      let done = false;
      while (!done) {
        await wait(2500);
        await syncJobsPanel();

        let st;
        try {
          const r = await fetch(API_JOB_DETAIL(jobId), {
            cache: "no-store",
            credentials: "same-origin",
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
          (completed ? API_JOB_DOWNLOAD(jobId) : null);

        JobsPanel.updateLocalJob(jobId, {
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
    } catch (e) {
      JobsPanel.updateLocalJob(jobId, {
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

  async function enqueue({ items, days, delayMs = 250, title, onJobCreated }) {
    const list = (Array.isArray(items) ? items : [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (!list.length) throw new Error("Nenhum MLB válido para enfileirar");

    const d = Number(days);
    if (!Number.isFinite(d) || d < 0 || Math.floor(d) !== d) {
      throw new Error("Dias inválidos. Use inteiro >= 0.");
    }

    QUEUE.push({ items: list, days: d, delayMs, title, onJobCreated });
    pump(); // não aguarda
  }

  async function verificarStatus() {
    if (!currentProcessId) throw new Error("Nenhum processamento ativo.");

    const r = await fetch(API_JOB_DETAIL(currentProcessId), {
      cache: "no-store",
      credentials: "same-origin",
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(data?.error || data?.message || `HTTP ${r.status}`);
    }
    return data?.job || data;
  }

  function hasActiveProcess() {
    return !!currentProcessId;
  }

  async function syncJobsPanel() {
    try {
      const r = await fetch(API_JOBS(), {
        cache: "no-store",
        credentials: "same-origin",
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && Array.isArray(data?.jobs)) {
        window.JobsPanel?.mergeApiJobs?.(data.jobs);
        window.JobsPanel?.show?.();
        return data.jobs;
      }
    } catch {}
    return [];
  }

  function isActiveJob(job) {
    if (!job) return false;
    if (job.completed === true) return false;
    return !isTerminalJobStateText(job.state || job.status || "");
  }

  function stopPanelSync() {
    if (panelSyncTimer) clearInterval(panelSyncTimer);
    panelSyncTimer = null;
  }

  function startPanelSync() {
    if (panelSyncTimer) return;
    const tick = async () => {
      const list = await syncJobsPanel();
      const hasActive = (Array.isArray(list) && list.some(isActiveJob)) ||
        !!window.JobsPanel?.hasRunningJobs?.();
      if (!hasActive) stopPanelSync();
    };
    tick();
    panelSyncTimer = setInterval(tick, 3000);
  }

  async function cancelJobFromPanel(job) {
    if (!job?.id) return false;
    const r = await fetch(API_JOB_CANCEL(job.backendJobId || job.id), {
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

  applyPrazoPanelVisibilityFilter();
  window.JobsPanel?.setCancelHandler?.(cancelJobFromPanel);
  startPanelSync();
  window.addEventListener("beforeunload", stopPanelSync);
  window.PrazoBulk = {
    enqueue,
    verificarStatus,
    hasActiveProcess,
    syncJobsPanel,
    startPanelSync,
  };
})();
