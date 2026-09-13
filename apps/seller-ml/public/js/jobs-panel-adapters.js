(function initJobsPanelAdapters(global) {
  "use strict";

  if (!global || global.JobsPanelAdapters) return;

  const customAdapters = new Map();

  function text(value) {
    return String(value == null ? "" : value).trim();
  }

  function token(value) {
    return text(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function moduleSlug(value) {
    return token(value)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "generic";
  }

  function createUid(adapterName, backendJobId) {
    const moduleName = moduleSlug(adapterName);
    const rawId = text(backendJobId);
    if (!rawId) return "";
    if (moduleName === "generic") return rawId;
    if (rawId.startsWith(`${moduleName}:`)) return rawId;
    return `${moduleName}:${rawId}`;
  }

  function backendId(adapterName, value) {
    const moduleName = moduleSlug(adapterName);
    const raw = text(value);
    const prefix = `${moduleName}:`;
    return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  }

  function number(value, fallback = NaN) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clamp(value) {
    const parsed = number(value, 0);
    return Math.max(0, Math.min(100, Math.round(parsed)));
  }

  function classifyState(value) {
    const state = token(value);
    if (!state) return "unknown";
    if (/paused_safety|pausad.*seguranca/.test(state)) return "paused_safety";
    if (/retry_wait|retomada automatica/.test(state)) return "retry_wait";
    if (/review_pending|revisao pendente|em revisao/.test(state)) return "review_pending";
    if (/cancelando|cancelling/.test(state)) return "canceling";
    if (/cancel|abort/.test(state)) return "canceled";
    if (/partial|parcial/.test(state)) return "partial";
    if (/conclu|finaliz|completed|complete\b|done\b|success|sucesso/.test(state)) {
      return "completed";
    }
    if (/fail|falh|error|erro/.test(state)) return "failed";
    if (/queue|pending|waiting|scheduled|agend|na fila|aguard/.test(state)) {
      return "queued";
    }
    if (/active|running|processing|processando|iniciando|preparando|carregando/.test(state)) {
      return "active";
    }
    return "unknown";
  }

  function reviewAction(raw, hasErrors) {
    const explicit =
      raw?.job_contract?.actions?.download_csv ||
      raw?.review_action ||
      raw?.reviewAction;
    if (explicit && explicit.url) {
      return {
        label: text(explicit.label) || "Baixar CSV",
        url: text(explicit.url),
        filename: text(explicit.filename) || null,
      };
    }

    const url = text(
      raw?.download_csv_url ||
        raw?.downloadCsvUrl ||
        raw?.endpoints?.download_csv_url ||
        raw?.endpoints?.downloadCsvUrl,
    );
    if (!url) return null;
    return {
      label: hasErrors ? "Ver e corrigir" : "Baixar CSV",
      url,
      filename: text(raw?.download_filename || raw?.filename) || null,
    };
  }

  function explicitCompletion(raw) {
    if (typeof raw?.completed === "boolean") return raw.completed;
    if (raw?.done === true || raw?.success === true || raw?.finished === true) return true;
    return null;
  }

  function normalizeBase(raw, adapterName) {
    const contract = raw?.job_contract || {};
    const contractProgress = contract?.progress || {};
    const processed = number(
      contractProgress.current ?? raw?.processed ?? raw?.done ?? raw?.ok ?? raw?.count_ok,
    );
    const success = number(
      raw?.success ?? raw?.succeeded ?? raw?.count_ok ?? raw?.counters?.success,
    );
    const total = number(
      contractProgress.total ?? raw?.total ?? raw?.expected_total ?? raw?.count_total,
    );
    const errors = number(
      raw?.errors ?? raw?.error_count ?? raw?.failed ?? raw?.failures,
      0,
    );
    const hasErrors = errors > 0;
    const stateBase = text(
      raw?.lifecycle_status || contract.status || raw?.state || raw?.status || raw?.result,
    );
    const stateKind = classifyState(stateBase);
    const explicit = explicitCompletion(raw);
    const action = reviewAction(raw, hasErrors);

    let progressValue = number(
      raw?.progress_percent ?? contractProgress.percent ?? raw?.progress ?? raw?.pct,
    );
    if (!Number.isFinite(progressValue) && Number.isFinite(processed) && total > 0) {
      progressValue = Math.round((processed / total) * 100);
    }
    const progress = clamp(progressValue);

    const strict = adapterName === "promocoes" || adapterName === "filtro-anuncios";
    const retryWait = stateKind === "retry_wait";
    const safetyPaused = stateKind === "paused_safety";
    const canceling = stateKind === "canceling";
    const reviewPending = stateKind === "review_pending";
    const active = stateKind === "active" || retryWait || canceling || reviewPending;
    const waiting = stateKind === "queued" || retryWait;
    const failedState = stateKind === "failed";
    const terminalState =
      stateKind === "completed" ||
      stateKind === "partial" ||
      stateKind === "canceled";
    const completedFromCounts =
      !strict &&
      explicit == null &&
      stateKind === "unknown" &&
      Number.isFinite(processed) &&
      total > 0 &&
      processed >= total;
    const completedFromProgress =
      !strict &&
      explicit == null &&
      stateKind === "unknown" &&
      progress >= 100;
    const completedFromAction =
      adapterName === "filtro-anuncios" &&
      explicit == null &&
      !!action &&
      !active &&
      !waiting &&
      !failedState;

    const completed =
      explicit === true ||
      (explicit !== false && terminalState) ||
      completedFromCounts ||
      completedFromProgress ||
      completedFromAction;
    const failed = (explicit !== true && failedState) || (completed && hasErrors);

    let displayState = stateBase;
    if (safetyPaused) {
      displayState = "pausado por seguranca";
    } else if (retryWait) {
      const attempt = number(raw?.retry_attempt, NaN);
      const maxAttempts = number(raw?.retry_max_attempts, NaN);
      displayState =
        Number.isFinite(attempt) && Number.isFinite(maxAttempts)
          ? `aguardando retomada automatica ${attempt}/${maxAttempts}`
          : "aguardando retomada automatica";
    } else if (reviewPending) {
      displayState =
        number(raw?.remediation_pending, 0) > 0
          ? `em revisao - ${number(raw?.remediation_pending, 0)} remediacao(oes) pendente(s)`
          : "em revisao";
    } else if (canceling) {
      displayState = "cancelando";
    } else if (stateKind === "queued") {
      const queuePosition = number(raw?.queue_position, NaN);
      const queueReason = text(raw?.queue_reason);
      if (queueReason === "cooperative_chunk") {
        displayState = "aguardando proxima fatia";
      } else {
        displayState = Number.isFinite(queuePosition)
          ? `na fila - posicao ${queuePosition}`
          : "na fila - aguardando worker";
      }
    } else if (!completed && !failed && Number.isFinite(processed) && total > 0) {
      displayState = `processando ${processed}/${total} - ${progress}%`;
    } else if (!displayState && waiting) {
      displayState = "na fila - aguardando worker";
    } else if (!displayState && active) {
      displayState = "processando";
    } else if (!displayState) {
      displayState = `${progress}%`;
    }

    const rawIdentity = text(raw?.job_uid || contract.uid || raw?.id || raw?.job_id || raw?.process_id);
    const rawBackendId = text(raw?.backend_job_id || contract.backend_id) ||
      backendId(adapterName, rawIdentity);
    const uid = text(raw?.job_uid || contract.uid) || createUid(adapterName, rawBackendId);

    return {
      adapter: adapterName,
      id: uid,
      backendJobId: rawBackendId || backendId(adapterName, uid),
      source: text(raw?.source || raw?.job_source || raw?.source_key || raw?.jobSource),
      title:
        text(raw?.title || raw?.label || raw?.name || raw?.job_name) ||
        (text(raw?.kind || raw?.job_kind || contract.kind) === "csv_export"
          ? "Exportacao CSV enriquecida"
          : text(raw?.kind || raw?.job_kind || contract.kind) === "query"
            ? "Filtro de anuncios"
            : "Processo"),
      processed,
      success,
      total,
      errors,
      hasErrors,
      progress,
      stateBase,
      displayState,
      stateKind,
      active,
      waiting,
      retryWait,
      safetyPaused,
      canceling,
      reviewPending,
      completed,
      failed,
      canCancel: raw?.can_cancel !== false && raw?.job_contract?.can_cancel !== false,
      cancelRequested: raw?.cancel_requested === true,
      retryAt: raw?.retry_at || null,
      retryAttempt: number(raw?.retry_attempt, NaN),
      retryMaxAttempts: number(raw?.retry_max_attempts, NaN),
      retryReason: text(raw?.retry_reason),
      operationId: text(raw?.operation_id) || null,
      remediationTotal: number(raw?.remediation_total, 0),
      remediationPending: number(raw?.remediation_pending, 0),
      remediationResolved: number(raw?.remediation_resolved, 0),
      remediationCritical: number(raw?.remediation_critical, 0),
      queuePosition: number(raw?.queue_position, NaN),
      queueWaitSeconds: number(raw?.queue_wait_seconds, 0),
      queueReason: text(raw?.queue_reason),
      workerStatus: text(raw?.worker_status),
      workerLastSeen: raw?.worker_last_seen || null,
      workerDelayed: raw?.worker_delayed === true,
      stalledWarning: raw?.stalled_warning === true,
      itemsPerMinute: number(raw?.items_per_minute, NaN),
      etaSeconds: number(raw?.eta_seconds, NaN),
      itemConcurrency: number(raw?.item_concurrency, NaN),
      itemConcurrencyMax: number(raw?.item_concurrency_max, NaN),
      lastItemDurationMs: number(raw?.last_item_duration_ms, NaN),
      completedFromExplicit: explicit === true,
      hasExplicitCompletion: explicit != null,
      completedFromState: explicit !== false && terminalState,
      completedFromCounts,
      completedFromProgress,
      failedFromState: failedState,
      accountKey:
        raw?.account?.key ||
        (raw?.account?.meli_conta_id != null ? text(raw.account.meli_conta_id) : null) ||
        (raw?.account?.meliContaId != null ? text(raw.account.meliContaId) : null) ||
        (raw?.accountKey != null ? text(raw.accountKey) : null) ||
        null,
      accountLabel: raw?.account?.label || raw?.accountLabel || null,
      updatedAt: raw?.updated_at ?? raw?.updatedAt ?? raw?.ts ?? raw?.timestamp,
      reviewAction: action,
      resumable: raw?.resumable === true,
      pending: number(raw?.pending, Math.max(0, total - processed)),
      resumeUrl: text(raw?.resume_url || raw?.resumeUrl) || null,
      fullReportUrl: text(raw?.full_report_url || raw?.fullReportUrl) || null,
      error: text(raw?.error || raw?.failedReason || raw?.failed_reason || raw?.message),
    };
  }

  function normalize(adapterName, raw) {
    const name = text(adapterName) || "generic";
    const custom = customAdapters.get(name);
    if (custom) return custom(raw, { normalizeBase, classifyState, clamp, number, text });
    return normalizeBase(raw, name);
  }

  function register(name, adapter) {
    const key = text(name);
    if (!key || typeof adapter !== "function") return false;
    customAdapters.set(key, adapter);
    return true;
  }

  global.JobsPanelAdapters = Object.freeze({
    normalize,
    register,
    classifyState,
    createUid,
    backendId,
  });
})(typeof window !== "undefined" ? window : globalThis);
