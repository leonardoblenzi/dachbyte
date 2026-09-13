"use strict";

const JOB_CONTRACT_VERSION = 1;
const TERMINAL_STATUSES = new Set(["completed", "partial", "failed", "canceled"]);

function text(value) {
  return String(value == null ? "" : value).trim();
}

function slug(value, fallback = "generic") {
  const normalized = text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampPercent(value) {
  const parsed = finite(value, 0);
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function createJobUid(moduleName, backendJobId) {
  const moduleId = slug(moduleName);
  const rawId = text(backendJobId);
  if (!rawId) return "";
  if (rawId.startsWith(`${moduleId}:`)) return rawId;
  return `${moduleId}:${rawId}`;
}

function backendJobIdFromUid(moduleName, value) {
  const moduleId = slug(moduleName);
  const raw = text(value);
  const prefix = `${moduleId}:`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

function classifyLifecycle(value) {
  const state = text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (!state) return "unknown";
  if (/cancelando|cancelling/.test(state)) return "processing";
  if (/paused_safety|pausad.*seguranca/.test(state)) return "paused_safety";
  if (/retry_wait|retomada automatica/.test(state)) return "retry_wait";
  if (/review_pending|revisao pendente|em revisao/.test(state)) return "review_pending";
  if (/cancel|abort/.test(state)) return "canceled";
  if (/conclu|finaliz|completed|complete\b|done\b|success|sucesso/.test(state)) {
    return "completed";
  }
  if (/fail|falh|error|erro/.test(state)) return "failed";
  if (/queue|pending|waiting|scheduled|agend|na fila|aguard/.test(state)) {
    return "queued";
  }
  if (/active|running|processing|processando|iniciando|preparando|carregando|cancelando/.test(state)) {
    return "processing";
  }
  return "unknown";
}

function resolveLifecycle(job, options = {}) {
  const explicit = text(options.lifecycleStatus || job.lifecycle_status);
  if (["queued", "processing", "retry_wait", "review_pending", "paused_safety", "completed", "partial", "failed", "canceled"].includes(explicit)) {
    return explicit;
  }

  const stateStatus = classifyLifecycle(
    options.status ?? job.status ?? job.state ?? job.phase ?? job.result,
  );
  const errors = finite(
    options.errors ?? job.errors ?? job.error_count ?? job.failed ?? job.failures,
    0,
  );
  const explicitlyCompleted =
    typeof options.completed === "boolean"
      ? options.completed
      : typeof job.completed === "boolean"
        ? job.completed
        : null;

  if (stateStatus === "canceled") return "canceled";
  if (stateStatus === "paused_safety") return "paused_safety";
  if (stateStatus === "retry_wait") return "retry_wait";
  if (stateStatus === "review_pending") return "review_pending";
  if (stateStatus === "failed" && explicitlyCompleted !== true) return "failed";
  if (explicitlyCompleted === true || stateStatus === "completed") {
    return errors > 0 ? "partial" : "completed";
  }
  if (stateStatus === "queued") return "queued";
  if (stateStatus === "processing") return "processing";
  if (explicitlyCompleted === false) return "processing";
  return "queued";
}

function attachJobContract(job, options = {}) {
  if (!job || typeof job !== "object") return job;

  const moduleName = slug(options.module || job.job_module || job.module || "generic");
  const backendJobId = backendJobIdFromUid(moduleName, text(
    options.backendJobId ??
      job.backend_job_id ??
      job.raw_id ??
      job.id ??
      job.job_id ??
      job.process_id,
  ));
  const lifecycleStatus = resolveLifecycle(job, options);
  const terminal = TERMINAL_STATUSES.has(lifecycleStatus);
  const errors = finite(
    options.errors ?? job.errors ?? job.error_count ?? job.failed ?? job.failures,
    0,
  );
  const current = finite(
    options.progressCurrent ?? job.progress_current ?? job.processed ?? job.done,
    null,
  );
  const total = finite(
    options.progressTotal ?? job.progress_total ?? job.total ?? job.expected_total,
    null,
  );
  let percent = finite(
    options.progressPercent ??
      (typeof job.progress === "number" ? job.progress : job.progress?.percent) ??
      job.progress_percent ??
      job.percent,
    null,
  );
  if (current != null && total != null && total > 0) {
    // Os contadores sao a fonte de verdade da cobertura do lote. O Bull pode
    // carregar progress=100 mesmo quando a execucao foi interrompida/cancelada.
    const coverage = Math.max(0, (current / total) * 100);
    percent = current < total ? Math.min(99, Math.round(coverage)) : 100;
  } else if (terminal) {
    // Sem contadores confiaveis, um estado terminal indica somente que a execucao encerrou.
    percent = 100;
  }
  percent = clampPercent(percent);
  const phase = text(options.phase ?? job.progress_phase ?? job.phase) || null;
  const downloadAction = job.review_action?.url
    ? job.review_action
    : job.download_csv_url
      ? {
          type: "download_csv",
          label: errors > 0 ? "Ver e corrigir" : "Baixar CSV",
          url: job.download_csv_url,
          download: true,
        }
      : null;
  const jobUid = createJobUid(moduleName, backendJobId);

  return {
    ...job,
    job_contract_version: JOB_CONTRACT_VERSION,
    job_uid: jobUid,
    job_module: moduleName,
    job_kind: text(options.kind ?? job.job_kind ?? job.kind ?? job.source) || null,
    backend_job_id: backendJobId,
    lifecycle_status: lifecycleStatus,
    terminal,
    completed: terminal,
    progress_percent: percent,
    can_cancel:
      typeof options.canCancel === "boolean"
        ? options.canCancel
        : typeof job.cancelable === "boolean"
          ? job.cancelable
          : !terminal,
    job_contract: {
      version: JOB_CONTRACT_VERSION,
      uid: jobUid,
      module: moduleName,
      kind: text(options.kind ?? job.job_kind ?? job.kind ?? job.source) || null,
      backend_id: backendJobId,
      status: lifecycleStatus,
      terminal,
      progress: {
        percent,
        current,
        total,
        phase,
      },
      errors,
      can_cancel:
        typeof options.canCancel === "boolean"
          ? options.canCancel
          : typeof job.cancelable === "boolean"
            ? job.cancelable
            : !terminal,
      actions: downloadAction ? { download_csv: downloadAction } : {},
    },
  };
}

module.exports = {
  JOB_CONTRACT_VERSION,
  TERMINAL_STATUSES,
  attachJobContract,
  backendJobIdFromUid,
  classifyLifecycle,
  createJobUid,
  resolveLifecycle,
};
