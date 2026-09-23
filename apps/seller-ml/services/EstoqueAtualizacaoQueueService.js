"use strict";

const Bull = require("bull");
const { makeBullClient } = require("../lib/redisClient");
const {
  processStockChanges,
  buildCsvRows,
  CSV_HEADER,
} = require("./EstoqueAtualizacaoService");
const { buildCsv, attachJobReview } = require("./jobReviewHelper");
const { recordAuthEvent } = require("./authAuditService");
const { loadWorkerCredentials } = require("./estoqueAtualizacaoWorkerCredentials");

const QUEUE_NAME = "estoque-atualizacao-queue";
const RECENT_LIMIT = 30;
const MAX_JOB_ROWS = 5000;
let queueInstance = null;
let workerStarted = false;
let stockProcessor = processStockChanges;
let credentialResolver = loadWorkerCredentials;

function getQueue() {
  if (!queueInstance) {
    queueInstance = new Bull(QUEUE_NAME, {
      createClient: (type) => makeBullClient(type, QUEUE_NAME),
    });
    queueInstance.on("error", (error) => {
      console.error("[EstoqueAtualizacaoQueue] erro na fila:", error?.message || error);
    });
  }
  return queueInstance;
}

function normalizeAccountKey(value) {
  const text = String(value || "").trim();
  return text && text !== "default" ? text : null;
}

function canAccessJob(job, accountKey) {
  const wanted = normalizeAccountKey(accountKey);
  const current = normalizeAccountKey(job?.data?.accountKey);
  return Boolean(wanted && current && wanted === current);
}

async function setJobProgress(job, value) {
  const progress = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  if (typeof job?.progress === "function") return job.progress(progress);
  if (typeof job?.updateProgress === "function") return job.updateProgress(progress);
  job._progress = progress;
  return progress;
}

async function getJobProgress(job) {
  try {
    if (typeof job?.progress === "function") {
      const value = job.progress();
      return typeof value?.then === "function" ? await value : value;
    }
  } catch {}
  return Number(job?._progress || 0);
}

function safeText(value, max = 700) {
  const text = value == null ? "" : String(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function actorBase(job = {}) {
  const ctx = job?.data?.auditContext || {};
  return {
    userId: Number(ctx.userId) || null,
    email: ctx.email || null,
    ip: ctx.ip || null,
    userAgent: ctx.userAgent || null,
    accountKey: ctx.accountKey || job?.data?.accountKey || null,
    accountLabel: ctx.accountLabel || job?.data?.accountLabel || null,
    meli_conta_id: ctx.meli_conta_id || job?.data?.mlCreds?.meli_conta_id || null,
  };
}

async function auditJob(job, evento, status, metadata = {}) {
  const actor = actorBase(job);
  return recordAuthEvent({
    userId: actor.userId,
    email: actor.email,
    evento,
    status,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: {
      accountKey: actor.accountKey,
      accountLabel: actor.accountLabel,
      meli_conta_id: actor.meli_conta_id,
      job_id: String(job?.id || ""),
      action: "bulk_stock_update",
      ...metadata,
    },
  }).catch((error) => {
    console.error("[EstoqueAtualizacaoQueue] audit erro:", error?.message || error);
  });
}

function countAttention(summary = {}) {
  return Number(summary.errors || 0) + Number(summary.divergent || 0);
}

async function cancellationRequested(job) {
  try {
    const fresh = await getQueue().getJob(job.id);
    return fresh?.data?.cancel_requested === true;
  } catch {
    return job?.data?.cancel_requested === true;
  }
}

async function processJob(job) {
  const total = Array.isArray(job?.data?.changes) ? job.data.changes.length : 0;
  job.data.__meta = {
    total,
    processed: 0,
    applied: 0,
    errors: 0,
    blocked: 0,
    stale: 0,
    divergent: 0,
    phase: "starting",
    startedAt: Date.now(),
  };
  await job.update(job.data);
  await setJobProgress(job, 1);
  await auditJob(job, "stock_bulk_update_job_started", "success", { total_rows: total });

  try {
    const accountKey = normalizeAccountKey(job.data?.accountKey);
    if (!accountKey) {
      const error = new Error("Conta Mercado Livre nao identificada para o job de estoque.");
      error.statusCode = 409;
      throw error;
    }
    const credentials = await credentialResolver(accountKey);
    if (!credentials?.accessToken) {
      const error = new Error("Nao foi possivel obter credenciais da conta Mercado Livre para o job de estoque.");
      error.statusCode = 503;
      throw error;
    }
    const result = await stockProcessor({
      accessToken: credentials.accessToken,
      mlCreds: credentials.mlCreds || {},
      changes: job.data.changes || [],
      shouldCancel: () => cancellationRequested(job),
      onProgress: async (progress = {}) => {
        const processed = Math.max(0, Number(progress.processed || 0));
        const summary = progress.summary || {};
        const pct = total > 0 ? 5 + Math.round((processed / total) * 90) : 5;
        job.data.__meta = {
          ...(job.data.__meta || {}),
          processed,
          applied: Number(summary.applied || 0),
          errors: countAttention(summary),
          blocked: Number(summary.blocked || 0),
          stale: Number(summary.stale || 0),
          divergent: Number(summary.divergent || 0),
          phase: progress.phase || "updating",
          current_mlb: progress.current_mlb || null,
          updatedAt: Date.now(),
        };
        await job.update(job.data);
        await setJobProgress(job, Math.min(95, pct));
      },
    });

    const summary = result.summary || {};
    job.data.__meta = {
      ...(job.data.__meta || {}),
      processed: Number(summary.processed || result.processed || 0),
      applied: Number(summary.applied || 0),
      errors: countAttention(summary),
      blocked: Number(summary.blocked || 0),
      stale: Number(summary.stale || 0),
      divergent: Number(summary.divergent || 0),
      canceled: Number(summary.canceled || 0),
      phase: result.canceled ? "canceled" : "finished",
      finishedAt: Date.now(),
    };
    await job.update(job.data);
    await setJobProgress(job, 100);

    await auditJob(
      job,
      result.canceled ? "stock_bulk_update_job_canceled" : "stock_bulk_update_job_completed",
      countAttention(summary) > 0 || Number(summary.blocked || 0) > 0 || Number(summary.stale || 0) > 0
        ? "warn"
        : "success",
      {
        total_rows: Number(summary.total || total),
        processed: Number(summary.processed || 0),
        applied: Number(summary.applied || 0),
        unchanged: Number(summary.unchanged || 0),
        blocked: Number(summary.blocked || 0),
        stale: Number(summary.stale || 0),
        divergent: Number(summary.divergent || 0),
        errors: Number(summary.errors || 0),
        canceled: Number(summary.canceled || 0),
        retryable: Number(summary.retryable || 0),
        multi_origin: result.multi_origin === true,
      },
    );

    return result;
  } catch (error) {
    job.data.__meta = {
      ...(job.data.__meta || {}),
      error: safeText(error?.message || error),
      statusCode: error?.statusCode || error?.status || null,
      phase: "failed",
      failedAt: Date.now(),
    };
    await job.update(job.data).catch(() => {});
    await auditJob(job, "stock_bulk_update_job_failed", "error", {
      total_rows: total,
      processed: Number(job.data.__meta?.processed || 0),
      error: safeText(error?.message || error),
      status_code: error?.statusCode || error?.status || null,
    });
    throw error;
  }
}

function normalizeState(state, job) {
  const text = String(state || "").toLowerCase();
  if (text === "completed") {
    if (job?.returnvalue?.canceled === true) return "cancelado";
    return "concluido";
  }
  if (text === "failed") return "erro";
  if (text === "active") return job?.data?.cancel_requested ? "cancelando" : "processando";
  if (text === "waiting" || text === "delayed") return "aguardando";
  return text || "processando";
}

async function jobToPayload(job) {
  if (!job) return null;
  const state = await job.getState().catch(() => "unknown");
  const progress = await getJobProgress(job);
  const result = job.returnvalue || {};
  const summary = result.summary || {};
  const meta = job.data?.__meta || {};
  const completed = state === "completed" || state === "failed";
  const errors = Math.max(
    Number(meta.errors || 0),
    countAttention(summary),
    state === "failed" ? 1 : 0,
  );
  const total = Number(summary.total || meta.total || job.data?.changes?.length || 0);
  const processed = Number(summary.processed ?? meta.processed ?? 0);
  const normalized = normalizeState(state, job);
  const base = {
    adapter: "estoque-atualizacao",
    id: String(job.id),
    title: job.data?.title || "Estoque - atualizacao em massa",
    state: normalized,
    status: normalized,
    progress: completed ? 100 : Math.max(0, Math.min(100, Number(progress || 0))),
    processed,
    total,
    errors,
    applied: Number(summary.applied ?? meta.applied ?? 0),
    blocked: Number(summary.blocked ?? meta.blocked ?? 0),
    stale: Number(summary.stale ?? meta.stale ?? 0),
    divergent: Number(summary.divergent ?? meta.divergent ?? 0),
    retryable: Number(summary.retryable || 0),
    cancel_requested: job.data?.cancel_requested === true,
    completed,
    error: meta.error || job.failedReason || null,
    failedReason: meta.error || job.failedReason || null,
    phase: meta.phase || null,
    current_mlb: meta.current_mlb || null,
    created_at: job.timestamp ? new Date(job.timestamp).toISOString() : null,
    updated_at: new Date(job.finishedOn || job.processedOn || Date.now()).toISOString(),
    account: {
      key: job.data?.accountKey || null,
      label: job.data?.accountLabel || null,
    },
    result: completed ? { summary } : null,
  };
  return attachJobReview(base, {
    completed,
    errors,
    hasCsv: completed && Array.isArray(result.rows) && result.rows.length > 0,
    basePath: "/api/estoque/atualizacao/jobs",
    label: errors > 0 ? "Baixar resultado" : "Baixar CSV",
  });
}

async function enqueueStockUpdateJob({
  accountKey,
  accountLabel,
  changes = [],
  auditContext = null,
  title = null,
} = {}) {
  const rows = Array.isArray(changes) ? changes : [];
  if (!rows.length) {
    const error = new Error("Nenhuma alteracao pronta foi enviada para a fila.");
    error.statusCode = 400;
    throw error;
  }
  if (rows.length > MAX_JOB_ROWS) {
    const error = new Error(`O lote esta limitado a ${MAX_JOB_ROWS} linhas.`);
    error.statusCode = 400;
    throw error;
  }
  if (!normalizeAccountKey(accountKey)) {
    const error = new Error("Conta Mercado Livre nao identificada para o job de estoque.");
    error.statusCode = 409;
    throw error;
  }

  const queue = getQueue();
  const job = await queue.add(
    {
      title: title || `Estoque - atualizar ${rows.length} ${rows.length === 1 ? "linha" : "linhas"}`,
      accountKey,
      accountLabel,
      changes: rows,
      auditContext,
      cancel_requested: false,
    },
    {
      attempts: 1,
      removeOnComplete: { age: 60 * 60 * 24 * 5, count: 100 },
      removeOnFail: { age: 60 * 60 * 24 * 5, count: 100 },
    },
  );
  return String(job.id);
}

function initWorker() {
  if (workerStarted) return getQueue();
  workerStarted = true;
  const queue = getQueue();
  queue.resume().catch((error) => {
    console.error("[EstoqueAtualizacaoQueue] falha ao retomar fila:", error?.message || error);
  });
  queue.process(1, processJob);
  queue.on("active", (job) => console.log("[EstoqueAtualizacaoQueue] job active:", job?.id));
  queue.on("completed", (job) => console.log("[EstoqueAtualizacaoQueue] job completed:", job?.id));
  queue.on("failed", (job, error) => console.error("[EstoqueAtualizacaoQueue] job failed:", job?.id, error?.message || error));
  queue.on("stalled", (job) => console.warn("[EstoqueAtualizacaoQueue] job stalled:", job?.id));
  console.log("[EstoqueAtualizacaoQueue] worker iniciado");
  return queue;
}

async function listStockUpdateJobs(limit = RECENT_LIMIT, { accountKey } = {}) {
  const queue = getQueue();
  const jobs = await queue.getJobs(
    ["active", "waiting", "delayed", "completed", "failed"],
    0,
    Math.max(1, Number(limit) || RECENT_LIMIT) - 1,
    false,
  );
  const list = [];
  for (const job of jobs) {
    if (!canAccessJob(job, accountKey)) continue;
    const payload = await jobToPayload(job);
    if (payload) list.push(payload);
  }
  return list.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
}

async function getStockUpdateJobDetail(id, { accountKey } = {}) {
  const job = await getQueue().getJob(id);
  if (!job || !canAccessJob(job, accountKey)) return null;
  const payload = await jobToPayload(job);
  const state = await job.getState().catch(() => "unknown");
  const result = job.returnvalue || {};
  return {
    ...payload,
    rows: state === "completed" && Array.isArray(result.rows) ? result.rows : [],
    summary: state === "completed" ? result.summary || null : null,
    seller_id: state === "completed" ? result.seller_id || null : null,
    multi_origin: state === "completed" ? result.multi_origin === true : false,
  };
}

async function getStockUpdateJobCsv(id, { accountKey } = {}) {
  const detail = await getStockUpdateJobDetail(id, { accountKey });
  if (!detail?.rows?.length) return null;
  return {
    filename: `atualizacao_estoque_${id}.csv`,
    csv: `\ufeff${buildCsv(buildCsvRows(detail.rows), CSV_HEADER)}`,
  };
}

async function cancelStockUpdateJob(id, { accountKey } = {}) {
  const queue = getQueue();
  const job = await queue.getJob(id);
  if (!job || !canAccessJob(job, accountKey)) return null;
  const state = await job.getState().catch(() => "unknown");
  if (["completed", "failed"].includes(state)) {
    return { ok: false, status: state, error: "Job ja finalizado." };
  }

  if (["waiting", "delayed"].includes(state)) {
    await auditJob(job, "stock_bulk_update_job_canceled", "warn", {
      total_rows: Number(job.data?.changes?.length || 0),
      before_start: true,
    });
    await job.remove();
    return { ok: true, status: "cancelado" };
  }

  job.data.cancel_requested = true;
  job.data.__meta = {
    ...(job.data.__meta || {}),
    phase: "canceling",
    cancelRequestedAt: Date.now(),
  };
  await job.update(job.data);
  return { ok: true, status: "cancelando" };
}

async function retryFailedStockJob(id, { accountKey, auditContext = null } = {}) {
  const queue = getQueue();
  const job = await queue.getJob(id);
  if (!job || !canAccessJob(job, accountKey)) return null;
  const state = await job.getState().catch(() => "unknown");
  if (state !== "completed") {
    const error = new Error("A nova tentativa so pode ser criada depois que o job terminar.");
    error.statusCode = 409;
    throw error;
  }

  const rows = Array.isArray(job.returnvalue?.rows) ? job.returnvalue.rows : [];
  const retryable = rows.filter((row) => row.retryable === true && row.write_applied !== true);
  if (!retryable.length) {
    const error = new Error("Este job nao possui erros seguros para nova tentativa automatica.");
    error.statusCode = 409;
    throw error;
  }

  const changes = retryable.map((row) => ({
    mlb: row.mlb,
    variation_id: row.variation_id || null,
    expected_current_stock: row.actual_current_stock,
    new_stock: row.requested_stock,
  }));
  const newId = await enqueueStockUpdateJob({
    accountKey: job.data.accountKey,
    accountLabel: job.data.accountLabel,
    changes,
    auditContext: auditContext || job.data.auditContext || null,
    title: `Estoque - nova tentativa de ${retryable.length} ${retryable.length === 1 ? "linha" : "linhas"}`,
  });
  await auditJob(job, "stock_bulk_update_retry_job_created", "warn", {
    source_job_id: String(job.id),
    retry_job_id: String(newId),
    retry_rows: retryable.length,
  });
  return { job_id: newId, rows: retryable.length };
}

module.exports = {
  enqueueStockUpdateJob,
  initWorker,
  listStockUpdateJobs,
  getStockUpdateJobDetail,
  getStockUpdateJobCsv,
  cancelStockUpdateJob,
  retryFailedStockJob,
  _test: {
    normalizeState,
    countAttention,
    canAccessJob,
    processJob,
    setQueue(queue) {
      queueInstance = queue;
    },
    setStockProcessor(processor) {
      stockProcessor = processor;
    },
    resetStockProcessor() {
      stockProcessor = processStockChanges;
    },
    setCredentialResolver(resolver) {
      credentialResolver = resolver;
    },
    resetCredentialResolver() {
      credentialResolver = loadWorkerCredentials;
    },
  },
};
