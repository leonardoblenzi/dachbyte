(function () {
  const __APP_BASE__ =
    window.__APP_BASE_PATH__ ||
    ((location.pathname || "").startsWith("/ml/") || (location.pathname || "") === "/ml"
      ? "/ml"
      : "");

  function withBase(path) {
    if (!__APP_BASE__) return path;
    if (!path) return __APP_BASE__;
    return path.startsWith("/") ? __APP_BASE__ + path : __APP_BASE__ + "/" + path;
  }

  const QUEUE = [];
  let running = false;
  let watcherStarted = false;
  let watcherTimer = null;

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function normalizePanelText(value) {
    return String(value || "").trim().toLowerCase();
  }

  function hasReadableAccountText(value) {
    return /[A-Za-zÀ-ÿ]/.test(String(value || "").trim());
  }

  function sanitizeAccountScope(key, label) {
    const rawKey = String(key || "").trim();
    const safeKey = normalizePanelText(rawKey) === "default" ? "" : rawKey;
    const rawLabel = String(label || "").trim();
    const picked = rawLabel || safeKey;
    if (!hasReadableAccountText(picked)) {
      return { key: "", label: "" };
    }
    return {
      key: safeKey,
      label: rawLabel || safeKey,
    };
  }

  function currentAccountScope() {
    const shellLabel = String(document.getElementById("account-current")?.textContent || "").trim();
    return sanitizeAccountScope(
      window.__ACCOUNT__?.key || "",
      shellLabel || window.__ACCOUNT__?.label || "",
    );
  }

  async function resolveCurrentAccountScope() {
    try {
      const fromWindow = currentAccountScope();
      if (fromWindow.key || fromWindow.label) return fromWindow;
      const response = await fetch(withBase("/api/account/current"), {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const payload = await response.json().catch(() => ({}));
      return sanitizeAccountScope(
        payload.accountKey || payload.key || "",
        payload.label || payload.accountKey || payload.key || "",
      );
    } catch {
      return { key: "", label: "" };
    }
  }

  function unwrapJob(raw) {
    return raw?.job || raw || null;
  }

  // Os endpoints desta tela podem referenciar o mesmo job em dois formatos:
  // - lista: "1"
  // - detalhe/criacao: "remove:1"
  // - contrato novo: "promocoes:remove:1"
  // Unificamos para evitar cards duplicados no JobsPanel.
  function normalizeRemoveJobId(value) {
    const id = String(value || "").trim();
    if (!id) return "";
    if (/^promocoes:remove:/i.test(id)) return id;
    if (/^remove:/i.test(id)) return id;
    return `remove:${id}`;
  }

  function normalizeRemoveBackendId(value) {
    const id = String(value || "").trim();
    if (!id) return "";
    if (/^promocoes:remove:/i.test(id)) return id.slice("promocoes:".length);
    if (/^remove:/i.test(id)) return id;
    return `remove:${id}`;
  }

  function isRemoveNamespace(value) {
    const id = normalizePanelText(value);
    return id.startsWith("promocoes:remove:") || id.startsWith("remove:");
  }

  function normalizeStatus(job) {
    const state = String(job?.state || job?.status || "").toLowerCase();
    if (/cancel/.test(state)) return "cancelado";
    if (/erro|fail/.test(state)) return "erro";
    if (/conclu|done|completed/.test(state)) return "concluido";
    if (/aguard|wait|queued|pend/.test(state)) return "aguardando";
    return "processando";
  }

  function shouldShowRemovePanelJob(job) {
    const source = normalizePanelText(job?.source || "");
    const id = normalizePanelText(job?.job_uid || job?.id || "");
    const backendId = normalizePanelText(job?.backendJobId || job?.backend_job_id || "");
    const isRemoveJob =
      source === "remove" ||
      isRemoveNamespace(id) ||
      isRemoveNamespace(backendId);
    if (!isRemoveJob) return false;

    const current = currentAccountScope();
    const jobAccount = sanitizeAccountScope(
      job?.account?.key || job?.accountKey || "",
      job?.account?.label || job?.accountLabel || "",
    );
    if (!current.key && !current.label) return false;
    if (!jobAccount.key && !jobAccount.label) return false;
    if (current.label && jobAccount.label) {
      const currentLabel = normalizePanelText(current.label);
      const jobLabel = normalizePanelText(jobAccount.label);
      return currentLabel === jobLabel || currentLabel.includes(jobLabel) || jobLabel.includes(currentLabel);
    }
    if (current.key && jobAccount.key) {
      return normalizePanelText(current.key) === normalizePanelText(jobAccount.key);
    }
    return false;
  }

  function applyRemovePanelVisibilityFilter() {
    window.JobsPanel?.setAdapter?.("promocoes");
    window.JobsPanel?.setVisibilityFilter?.(shouldShowRemovePanelJob);
  }

  applyRemovePanelVisibilityFilter();

  function bindCancelHandler() {
    if (!window.JobsPanel?.setCancelHandler) return;
    window.JobsPanel.setCancelHandler(async (job) => {
      if (!job?.id) return false;
      const response = await fetch(
        withBase(`/api/promocoes/jobs/${encodeURIComponent(job.backendJobId || job.id)}/cancel`),
        {
          method: "POST",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        }
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }

      const nextStatus = String(payload?.status || "").toLowerCase();
      const canceling = /cancelando/.test(nextStatus);
      window.JobsPanel.updateLocalJob(job.id, {
        state: canceling ? "cancelando" : "cancelado",
        completed: !canceling,
        progress: canceling ? Number(job.progress || 0) : 100,
      });
      return true;
    });
  }

  function normalizeListJob(job) {
    if (!job?.id) return null;
    const rawSource = normalizePanelText(job?.source || "");
    const rawId = String(job.job_uid || job.id || "").trim();
    const rawBackendId = String(job.backend_job_id || job.backendJobId || job.id || "").trim();
    const normalizedId =
      rawSource === "remove" || isRemoveNamespace(rawId) || isRemoveNamespace(rawBackendId)
        ? normalizeRemoveJobId(rawId)
        : rawId;
    const normalizedBackendId =
      rawSource === "remove" || isRemoveNamespace(normalizedId) || isRemoveNamespace(rawBackendId)
        ? normalizeRemoveBackendId(rawBackendId || normalizedId)
        : rawBackendId;
    const effectiveSource =
      rawSource ||
      (isRemoveNamespace(normalizedId) || isRemoveNamespace(normalizedBackendId) ? "remove" : "");
    const titleFallback =
      effectiveSource === "remove" ? "Remocao de promocoes" : "Processo de promocoes";
    const safeAccount = sanitizeAccountScope(
      job.account?.key || job.accountKey || "",
      job.account?.label || job.accountLabel || "",
    );
    return {
      id: normalizedId,
      job_uid: /^promocoes:remove:/i.test(normalizedId) ? normalizedId : job.job_uid || null,
      backend_job_id: normalizedBackendId || null,
      backendJobId: normalizedBackendId || null,
      source: effectiveSource,
      title: job.title || titleFallback,
      state: job.state || job.status || "aguardando",
      status: job.status || job.state || "aguardando",
      progress: Number(job.progress ?? job.progresso ?? 0),
      processed: Number(job.processed ?? job.processados ?? 0),
      total: Number(job.total ?? job.total_anuncios ?? 0),
      errors: Number(job.errors ?? job.erros ?? 0),
      completed: !!job.completed,
      account:
        safeAccount.key || safeAccount.label
          ? {
              key: safeAccount.key || null,
              label: safeAccount.label || null,
            }
          : null,
      accountKey: safeAccount.key,
      accountLabel: safeAccount.label,
      updatedAt: job.updated_at || job.updatedAt || null,
      updated_at: job.updated_at || job.updatedAt || null,
      download_csv_url: job.download_csv_url || null,
      review_action:
        job.review_action && job.review_action.url
          ? {
              label: job.review_action.label || "Baixar CSV",
              url: job.review_action.url,
            }
          : null,
    };
  }

  async function pollList() {
    try {
      const response = await fetch(withBase("/api/promocoes/jobs?source=remove"), {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return;

      const payload = await response.json().catch(() => ({}));
      const list = Array.isArray(payload?.jobs)
        ? payload.jobs
            .map(normalizeListJob)
            .filter(Boolean)
            .filter((job) => shouldShowRemovePanelJob(job))
        : [];

      if (window.JobsPanel?.mergeApiJobs) {
        window.JobsPanel.mergeApiJobs(list);
      }

      const hasActive = list.some((job) => !job.completed);
      if (!hasActive && watcherTimer) {
        clearInterval(watcherTimer);
        watcherTimer = null;
        watcherStarted = false;
      }
    } catch {}
  }

  function startWatcher() {
    bindCancelHandler();
    if (watcherStarted) return;
    watcherStarted = true;
    watcherTimer = setInterval(pollList, 3000);
    pollList();
  }

  async function startJob(entry) {
    const account = await resolveCurrentAccountScope();
    if (!account.key && !account.label) {
      throw new Error("Conta selecionada e obrigatoria para iniciar a remocao.");
    }

    const tempId = JobsPanel.addLocalJob({
      title: entry.title || `Remocao - ${entry.items.length} itens`,
      source: "remove",
      accountKey: account.key || null,
      accountLabel: account.label || null,
    });

    let jobId = tempId;

    try {
      const response = await fetch(withBase("/api/promocoes/jobs/remove"), {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          items: entry.items,
          delay_ms: entry.delayMs ?? 250,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok || !payload.job_id) {
        JobsPanel.updateLocalJob(jobId, {
          progress: 100,
          state: "erro ao iniciar",
          completed: true,
        });
        return;
      }

      jobId = JobsPanel.replaceId(
        tempId,
        normalizeRemoveJobId(payload.job_id || payload.process_id || payload.id),
      );
      JobsPanel.updateLocalJob(jobId, {
        accountKey: account.key || null,
        accountLabel: account.label || null,
      });
      if (typeof entry.onJobCreated === "function") {
        try {
          entry.onJobCreated(jobId, {
            accountKey: account.key || null,
            accountLabel: account.label || null,
          });
        } catch {}
      }

      startWatcher();

      let done = false;
      let missingStreak = 0;
      while (!done) {
        await wait(2500);
        if (JobsPanel.isJobVisible?.(jobId) === false) break;

        let job = null;
        let statusCode = 0;
        try {
          const r = await fetch(withBase(`/api/promocoes/jobs/${encodeURIComponent(jobId)}`), {
            cache: "no-store",
            credentials: "same-origin",
            headers: { Accept: "application/json" },
          });
          statusCode = Number(r.status || 0);
          const raw = await r.json().catch(() => ({}));
          job = unwrapJob(raw);
        } catch {}

        if (statusCode === 404) {
          if (JobsPanel.isJobVisible?.(jobId) === false) break;
          missingStreak++;
          if (missingStreak >= 3) break;
          continue;
        }
        if (!job) continue;
        missingStreak = 0;

        const status = normalizeStatus(job);
        const progress = Number(job.progress ?? 0);
        const processed = Number(job.processed ?? 0);
        const total = Number(job.total ?? 0);
        const errors = Number(job.errors ?? 0);

        let stateText = String(job.state || job.status || "").trim();
        if (!stateText) {
          if (status === "concluido") {
            stateText = errors > 0 ? "concluido com erros" : "concluido";
          } else if (status === "cancelado") {
            stateText = "cancelado";
          } else if (status === "aguardando") {
            stateText = "aguardando";
          } else {
            stateText =
              Number.isFinite(processed) && Number.isFinite(total) && total > 0
                ? `processando ${processed}/${total}`
                : `processando ${progress}%`;
          }
        }

        JobsPanel.updateLocalJob(jobId, {
          progress: Number.isFinite(progress) ? progress : 0,
          processed,
          total,
          errors,
          state: stateText,
          completed: status === "concluido" || status === "cancelado" || status === "erro",
          reviewAction:
            job.review_action && job.review_action.url
              ? {
                  label: job.review_action.label || "Baixar CSV",
                  url: job.review_action.url,
                }
              : null,
          downloadCsvUrl: job.download_csv_url || null,
        });

        done = status === "concluido" || status === "cancelado" || status === "erro";
      }
    } catch (error) {
      JobsPanel.updateLocalJob(jobId, {
        progress: 100,
        state: error?.message || "falha inesperada",
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

  async function enqueue({ items, delayMs = 250, title, onJobCreated }) {
    const list = (Array.isArray(items) ? items : [])
      .map((value) => String(value).trim())
      .filter(Boolean);
    if (!list.length) throw new Error("Nenhum MLB valido para enfileirar");
    QUEUE.push({ items: list, delayMs, title, onJobCreated });
    pump();
  }

  document.addEventListener("DOMContentLoaded", async () => {
    try {
      await window.AccountBar?.ensure?.();
    } catch {}
    applyRemovePanelVisibilityFilter();
    startWatcher();
  });

  window.RemocaoBulk = { enqueue, startWatcher, refreshJobs: pollList };
})();
