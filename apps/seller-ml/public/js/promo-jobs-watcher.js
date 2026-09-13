// promo-jobs-watcher.js
// Cache e polling de jobs da central de promocoes.
(function initPromoJobsWatcher(global) {
  "use strict";

  if (!global || global.PromoJobsWatcher) return;

  const JobTitleCache = (() => {
    const KEY = "davanti_job_titles_v1";
    let map = {};
    try {
      map = JSON.parse(localStorage.getItem(KEY) || "{}");
    } catch {}

    function set(id, title) {
      if (!id || !title) return;
      map[String(id)] = String(title);
      try {
        localStorage.setItem(KEY, JSON.stringify(map));
      } catch {}
    }

    function get(id) {
      return map[String(id)] || null;
    }

    return { set, get };
  })();

  function buildWatcher() {
    let timer = null;
    let periodMs = 5000;
    let idleTicks = 0;
    let cancelHandlerBound = false;
    let jobsFilter = null;
    let pollInFlight = false;

    const IDLE_TICKS_TO_STOP = 3;
    const ACTIVE_PERIOD = 3000;
    const IDLE_PERIOD = 15000;
    const HIDDEN_PERIOD = 30000;

    function normalizeJobState(job) {
      const lifecycle = String(job?.lifecycle_status || job?.job_contract?.status || "").toLowerCase();
      const sRaw = String(job?.state || job?.status || "").toLowerCase();
      const stateText = `${lifecycle} ${sRaw}`;
      const processed = Number(job?.processed ?? job?.job_contract?.progress?.current ?? 0);
      const total = Number(job?.total ?? job?.job_contract?.progress?.total ?? 0);
      const rawProgress = Number(
        job?.progress_percent ?? job?.job_contract?.progress?.percent ?? job?.progress ?? NaN,
      );
      const progress = Number.isFinite(rawProgress)
        ? Math.max(0, Math.min(100, Math.round(rawProgress)))
        : total > 0
          ? Math.max(0, Math.min(100, Math.round((processed / total) * 100)))
          : 0;

      if (lifecycle === "paused_safety" || job?.safety_paused === true) {
        return { state: "paused_safety", progress, processed, total };
      }
      if (lifecycle === "retry_wait" || job?.retry_wait === true) {
        return { state: "retry_wait", progress, processed, total };
      }
      if (lifecycle === "review_pending") {
        return { state: "review_pending", progress, processed, total };
      }
      if (job?.cancel_requested === true || /cancelando|cancelling/.test(stateText)) {
        return { state: "cancelando", progress, processed, total };
      }
      if (lifecycle === "canceled" || /cancelado|canceled|cancelled|aborted/.test(stateText)) {
        return { state: "canceled", progress, processed, total };
      }
      if (lifecycle === "failed") {
        return { state: "failed", progress, processed, total };
      }
      if (lifecycle === "completed" || lifecycle === "partial") {
        return { state: lifecycle, progress, processed, total };
      }
      if (lifecycle === "queued") {
        return { state: "queued", progress, processed, total };
      }
      if (lifecycle === "processing") {
        return { state: "active", progress, processed, total };
      }

      const isQueuedText =
        stateText.includes("queue") ||
        stateText.includes("waiting") ||
        stateText.includes("pend") ||
        stateText.includes("scheduled") ||
        stateText.includes("agend");
      const isActiveText =
        stateText.includes("active") ||
        stateText.includes("running") ||
        stateText.includes("processing") ||
        stateText.includes("processando") ||
        stateText.includes("iniciando");
      const isFailedText =
        stateText.includes("fail") ||
        stateText.includes("falhou") ||
        stateText.includes("error");
      const byCounts = total > 0 && processed >= total;

      if (isActiveText) return { state: "active", progress, processed, total };
      if (isQueuedText) return { state: "queued", progress, processed, total };
      if (isFailedText) return { state: "failed", progress, processed, total };
      if (
        byCounts ||
        stateText.includes("conclu") ||
        stateText.includes("completed") ||
        stateText.includes("done") ||
        stateText.includes("finaliz")
      ) {
        return { state: "completed", progress, processed, total };
      }

      return { state: "active", progress, processed, total };
    }

    function normalizeJob(job) {
      const norm = normalizeJobState(job);
      return {
        ...job,
        state: norm.state,
        status: norm.state,
        progress: norm.progress,
        processed: norm.processed,
        total: norm.total,
      };
    }

    function anyRunning(list) {
      const backendRunning = list.some((j) =>
        ["active", "queued", "retry_wait", "review_pending", "cancelando"].includes(j.state),
      );
      if (backendRunning) return true;
      return !!global.JobsPanel?.hasRunningJobs?.();
    }

    function setPeriod(ms) {
      ms = Number(ms);
      if (!isFinite(ms) || ms <= 0) return;

      if (!timer) {
        periodMs = ms;
        return;
      }
      if (ms === periodMs) return;

      periodMs = ms;
      clearInterval(timer);
      timer = setInterval(poll, periodMs);
    }

    async function poll() {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        const jobsUrl =
          typeof global.withBase === "function"
            ? global.withBase("/api/promocoes/jobs")
            : global.ML?.url?.("/api/promocoes/jobs") ||
              "/api/promocoes/jobs";

        const r = await fetch(jobsUrl, {
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json", "Cache-Control": "no-cache" },
        });
        if (!r.ok) return;

        const data = await r.json().catch(() => ({}));
        const raw = Array.isArray(data?.jobs) ? data.jobs : [];
        let list = raw.map(normalizeJob);
        if (typeof jobsFilter === "function") {
          list = list.filter((job) => {
            try {
              return jobsFilter(job) !== false;
            } catch {
              return true;
            }
          });
        }

        for (const j of list) {
          const t = JobTitleCache.get(j.id);
          if (t) {
            j.title = j.title || t;
            j.label = j.label || t;
          }
        }

        if (global.JobsPanel?.mergeApiJobs && Array.isArray(list)) {
          global.JobsPanel.mergeApiJobs(list, { adapter: "promocoes" });
        }

        if (anyRunning(list)) {
          idleTicks = 0;
          setPeriod(document.hidden ? HIDDEN_PERIOD : ACTIVE_PERIOD);
          return;
        }

        idleTicks++;
        setPeriod(document.hidden ? HIDDEN_PERIOD : IDLE_PERIOD);

        if (idleTicks >= IDLE_TICKS_TO_STOP && !global.JobsPanel?.hasRunningJobs?.()) {
          stop();
        }
      } catch (e) {
        console.error("[PromoJobsWatcher.poll] erro ao atualizar jobs:", e);
      } finally {
        pollInFlight = false;
      }
    }

    function bindCancelHandler() {
      if (cancelHandlerBound || !global.JobsPanel?.setCancelHandler) return;

      global.JobsPanel.setCancelHandler(async (job) => {
        const backendJobId = String(job?.backendJobId || job?.id || "").trim();
        if (!backendJobId) {
          return { ok: false, error: "Job sem identificador no backend." };
        }

        const cancelUrl =
          typeof global.withBase === "function"
            ? global.withBase(`/api/promocoes/jobs/${encodeURIComponent(backendJobId)}/cancel`)
            : global.ML?.url?.(`/api/promocoes/jobs/${encodeURIComponent(backendJobId)}/cancel`) ||
              `/api/promocoes/jobs/${encodeURIComponent(backendJobId)}/cancel`;

        const r = await fetch(cancelUrl, {
          method: "POST",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        const data = await r.json().catch(() => ({}));

        if (!r.ok || data?.ok === false) {
          return {
            ok: false,
            status: Number(r.status || 0),
            error: data?.error || data?.message || `HTTP ${r.status}`,
          };
        }

        const canceling = /cancelando/i.test(String(data?.status || data?.lifecycle_status || ""));
        const canceled = !canceling && /cancel/i.test(
          String(data?.status || data?.lifecycle_status || "cancelado"),
        );
        const processed = Number(data?.processed ?? job?.processed ?? 0);
        const total = Number(data?.total ?? job?.total ?? 0);
        const progress = Number.isFinite(Number(data?.progress))
          ? Number(data.progress)
          : total > 0
            ? Math.round((processed / total) * 100)
            : Number(job?.progress || 0);

        global.JobsPanel?.updateLocalJob?.(job.id, {
          state: canceling ? "cancelando" : canceled ? "cancelado" : String(data?.status || "cancelando"),
          completed: canceled,
          progress,
          processed,
          total,
          resumable: false,
          safetyPaused: false,
          cancelRequested: canceling,
        });

        // Reconciliacao imediata: o card permanece visivel ate o backend confirmar o estado final.
        setTimeout(() => poll(), 250);
        return {
          ok: true,
          status: canceling ? "cancelando" : "cancelado",
          completed: canceled,
          processed,
          total,
          progress,
        };
      });
      cancelHandlerBound = true;
    }

    function start() {
      bindCancelHandler();
      if (timer) {
        poll();
        return;
      }
      idleTicks = 0;
      periodMs = document.hidden ? HIDDEN_PERIOD : ACTIVE_PERIOD;
      timer = setInterval(poll, periodMs);
      poll();
    }

    function stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    }

    function isRunning() {
      return !!timer;
    }

    function setFilter(fn) {
      jobsFilter = typeof fn === "function" ? fn : null;
      if (timer) poll();
    }

    document.addEventListener("visibilitychange", () => {
      if (!timer && !document.hidden && global.JobsPanel?.hasRunningJobs?.()) {
        start();
        return;
      }
      if (!timer) return;
      setPeriod(document.hidden ? HIDDEN_PERIOD : ACTIVE_PERIOD);
      if (!document.hidden) poll();
    });

    window.addEventListener("focus", () => {
      if (!timer && global.JobsPanel?.hasRunningJobs?.()) {
        start();
        return;
      }
      if (timer) poll();
    });

    window.addEventListener("pageshow", () => {
      if (!timer && global.JobsPanel?.hasRunningJobs?.()) {
        start();
        return;
      }
      if (timer) poll();
    });

    return { start, stop, isRunning, poll, setFilter };
  }

  global.PromoJobTitleCache = JobTitleCache;
  global.PromoJobsWatcher = buildWatcher();
})(window);
