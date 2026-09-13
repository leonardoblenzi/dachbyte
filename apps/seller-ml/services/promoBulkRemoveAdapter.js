"use strict";

const Bull = require("bull");
const { makeBullClient } = require("../lib/redisClient");
const PromocaoService = require("./removerPromocaoService");
const { buildCsv, attachJobReview } = require("./jobReviewHelper");
const { recordAuthEvent } = require("./authAuditService");

const QUEUE_NAME = "ml-promo-bulk-remove";

let queueInstance = null;
let workerStarted = false;

class JobCancelledError extends Error {
  constructor(message = "Job cancelado pelo usuario.") {
    super(message);
    this.name = "JobCancelledError";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getQueue() {
  if (!queueInstance) {
    queueInstance = new Bull(QUEUE_NAME, {
      createClient: (type) => makeBullClient(type, QUEUE_NAME),
    });
  }
  return queueInstance;
}

function makeRemoveJobId() {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 10);
  return `rmv_${ts}_${rnd}`;
}

function clampProgress(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function positiveNumber(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function pickArray(...values) {
  return values.find((value) => Array.isArray(value)) || [];
}

function countResultRows(rows, wanted) {
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((count, row) => {
    const status = String(row?.status || "").toLowerCase();
    if (wanted === "success") {
      return row?.success === true || ["success", "applied", "removed"].includes(status)
        ? count + 1
        : count;
    }
    return row?.success === false || ["error", "failed", "failure"].includes(status)
      ? count + 1
      : count;
  }, 0);
}

function safeText(value, max = 500) {
  const text = value == null ? "" : String(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function buildAuditBase(job) {
  const context = job?.data?.auditContext || {};
  return {
    userId: Number(context.userId) || null,
    email: context.email || null,
    ip: context.ip || null,
    userAgent: context.userAgent || null,
    accountKey: context.accountKey || job?.data?.accountKey || null,
    accountLabel: context.accountLabel || job?.data?.accountLabel || null,
    meli_conta_id: context.meli_conta_id || job?.data?.mlCreds?.meli_conta_id || null,
    route: context.route || null,
    method: context.method || null,
    action: "remove",
    job_id: job?.id ? String(job.id) : null,
  };
}

async function auditRemoveJobEvent(job, evento, status, metadata = {}) {
  const base = buildAuditBase(job);
  return recordAuthEvent({
    userId: base.userId,
    email: base.email,
    evento,
    status,
    ip: base.ip,
    userAgent: base.userAgent,
    metadata: {
      accountKey: base.accountKey,
      accountLabel: base.accountLabel,
      meli_conta_id: base.meli_conta_id,
      route: base.route,
      method: base.method,
      action: base.action,
      job_id: base.job_id,
      ...metadata,
    },
  }).catch((err) => {
    console.error("[PromoBulkRemoveAdapter] audit erro:", err?.message || err);
  });
}

function resolveJobMetrics(job, meta = {}) {
  const result = job?.returnvalue || {};
  const results = pickArray(meta.results, result.results);
  const failedItems = pickArray(meta.failedItems, result.failedItems, result.failed_items);
  const successFromRows = countResultRows(results, "success");
  const failedFromRows = Math.max(countResultRows(results, "failed"), failedItems.length);
  const processedFromRows = successFromRows + failedFromRows;
  const processed = Math.max(
    positiveNumber(meta.processed),
    positiveNumber(result.processed),
    processedFromRows,
  );
  const total = Math.max(
    positiveNumber(meta.total),
    positiveNumber(result.total),
    processed,
    Array.isArray(job?.data?.mlbIds) ? job.data.mlbIds.length : 0,
  );
  const success = Math.max(
    positiveNumber(meta.success),
    positiveNumber(result.success),
    successFromRows,
  );
  const failed = Math.max(
    positiveNumber(meta.failed),
    positiveNumber(result.failed),
    failedFromRows,
  );

  return { total, processed, success, failed, results, failedItems };
}

function buildAccount(data = {}) {
  const key = data.accountKey || null;
  const label = data.accountLabel || key || null;
  return key || label ? { key, label } : null;
}

function normalizeAccountKey(value) {
  const v = String(value || "").trim();
  if (!v) return null;
  if (v.toLowerCase() === "default") return null;
  return v;
}

function canAccessJob(job, accountKey) {
  const wanted = normalizeAccountKey(accountKey);
  const current = normalizeAccountKey(job?.data?.accountKey);
  if (!wanted) return false;
  if (!current) return false;
  return current === wanted;
}

async function updateMeta(job, meta) {
  job.data.__meta = {
    ...(job.data.__meta || {}),
    ...meta,
  };
  await job.update(job.data);
}

async function removeOneDirect({ mlb, mlCreds, accountKey }) {
  try {
    const res = await PromocaoService.removerPromocaoUnico(mlb, {
      mlCreds,
      accountKey,
      logger: console,
    });
    return {
      ok: !!res?.success,
      status: res?.success ? 200 : 400,
      body: res || null,
    };
  } catch (e) {
    return { ok: false, status: 500, error: e?.message || String(e) };
  }
}

async function runJob(job) {
  const mlbIds = Array.isArray(job.data?.mlbIds)
    ? job.data.mlbIds.map((id) => String(id || "").trim().toUpperCase()).filter(Boolean)
    : [];
  const delayMs = Math.max(0, Number(job.data?.delayMs || 0));
  const total = mlbIds.length;

  await updateMeta(job, {
    status: "processando",
    total,
    processed: 0,
    success: 0,
    failed: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  });
  await job.progress(0);

  await auditRemoveJobEvent(job, "promotion_job_processing_started", "success", {
    total_items: total,
    delay_ms: delayMs,
    sample_ids: mlbIds.slice(0, 20),
  });

  let success = 0;
  let failed = 0;
  const failedItems = [];
  const results = [];

  for (let index = 0; index < mlbIds.length; index++) {
    if (job.data?.__meta?.cancelRequested) {
      throw new JobCancelledError();
    }
    const mlbId = mlbIds[index];
    const result = await removeOneDirect({
      mlb: mlbId,
      mlCreds: job.data?.mlCreds || {},
      accountKey: job.data?.accountKey || null,
    });
    const row = {
      mlb_id: mlbId,
      status: result?.ok ? "success" : "error",
      success: !!result?.ok,
      message:
        result?.error ||
        result?.body?.message ||
        result?.body?.error ||
        (result?.ok ? "Processado com sucesso" : "Falha ao remover promocao"),
    };
    results.push(row);

    if (result?.ok) {
      success += 1;
    } else {
      failed += 1;
      if (failedItems.length < 200) {
        failedItems.push({
          mlb_id: mlbId,
          message:
            result?.error ||
            result?.body?.message ||
            result?.body?.error ||
            "Falha ao remover promocao",
        });
      }
    }

    await auditRemoveJobEvent(job, "promotion_item_processed", row.success ? "success" : "warn", {
      mlb_id: mlbId,
      item_index: index + 1,
      total_items: total,
      success: row.success,
      ml_status: result?.status ?? null,
      message: safeText(row.message),
      ml_body: result?.body || null,
    });

    const processed = index + 1;
    const progress = total > 0 ? clampProgress((processed / total) * 100) : 100;

    await updateMeta(job, {
      status: "processando",
      total,
      processed,
      success,
      failed,
      failedItems,
      results,
      updatedAt: Date.now(),
    });
    await job.progress(progress);

    if (delayMs > 0 && processed < total) {
      await sleep(delayMs);
    }
  }

  await updateMeta(job, {
    status: "concluido",
    total,
    processed: total,
    success,
    failed,
    failedItems,
    results,
    finishedAt: Date.now(),
    updatedAt: Date.now(),
  });
  await job.progress(100);

  await auditRemoveJobEvent(job, "promotion_job_completed", failed > 0 ? "warn" : "success", {
    total_items: total,
    processed: total,
    success,
    failed,
  });

  return {
    ok: true,
    total,
    success,
    failed,
    failedItems,
    results,
  };
}

async function mapJob(job) {
  if (!job) return null;

  const state = await job.getState().catch(() => "unknown");
  const meta = job.data?.__meta || {};
  const { total, processed, success, failed, results, failedItems } =
    resolveJobMetrics(job, meta);
  const progress =
    total > 0 ? clampProgress((processed / total) * 100) : clampProgress(job._progress ?? 0);

  let status = meta.status || state;
  if (state === "failed") status = "erro";
  else if (state === "completed" && status !== "concluido") status = "concluido";
  else if (state === "waiting" || state === "delayed") status = "aguardando";

  let stateLabel = status;
  if (status === "concluido") {
    stateLabel = `concluido: ${success} ok, ${failed} erros`;
  } else if (status === "erro") {
    stateLabel = "erro";
  } else if (status === "cancelando") {
    stateLabel = "cancelando";
  } else if (status === "cancelado") {
    stateLabel = "cancelado";
  } else if (status === "aguardando") {
    stateLabel = "aguardando";
  } else {
    stateLabel = total > 0 ? `processando ${processed}/${total}` : "processando";
  }

  const startedAt = meta.startedAt || job.processedOn || job.timestamp;
  const finishedAt = meta.finishedAt || job.finishedOn || null;

  return attachJobReview({
    id: String(job.id),
    title: `Remocao - ${total} item(ns)`,
    state: stateLabel,
    status,
    progress,
    progresso: progress,
    processed,
    processados: processed,
    total,
    total_anuncios: total,
    errors: failed,
    erros: failed,
    success,
    sucessos: success,
    created_at: new Date(job.timestamp).toISOString(),
    updated_at: new Date(meta.updatedAt || finishedAt || startedAt || job.timestamp).toISOString(),
    iniciado_em: startedAt ? new Date(startedAt).toISOString() : null,
    concluido_em: finishedAt ? new Date(finishedAt).toISOString() : null,
    completed: status === "concluido" || status === "erro",
    account: buildAccount(job.data),
    meta: { successes: success },
    result: status === "concluido" ? job.returnvalue || null : null,
    failed_items: failedItems,
  }, {
    basePath: "/api/promocoes/jobs",
    jobId: `remove:${job.id}`,
    hasCsv: results.length > 0 || failedItems.length > 0,
  });
}

function getJobResults(job) {
  const meta = job?.data?.__meta || {};
  if (Array.isArray(meta.results)) return meta.results;
  if (Array.isArray(job?.returnvalue?.results)) return job.returnvalue.results;
  return [];
}

async function getJobCsv(id, { accountKey = null } = {}) {
  const queue = getQueue();
  const job = await queue.getJob(String(id));
  if (!job) return null;
  if (!canAccessJob(job, accountKey)) return null;

  const rows = getJobResults(job);
  const csv = buildCsv(
    rows.map((row) => [
      row?.mlb_id || "",
      row?.status || (row?.success ? "success" : "error"),
      row?.message || "",
    ]),
    ["mlb_id", "status", "message"],
  );

  return {
    filename: `remover_promocao_${id}.csv`,
    csv: `\ufeff${csv}`,
  };
}

async function startRemoveJob({
  mlbIds = [],
  delayMs = 250,
  mlCreds = {},
  accountKey = null,
  accountLabel = null,
  auditContext = null,
}) {
  if (!Array.isArray(mlbIds) || !mlbIds.length) {
    throw new Error("Nenhum MLB informado.");
  }
  const resolvedAccountKey = normalizeAccountKey(accountKey);
  if (!resolvedAccountKey) {
    throw new Error("Conta obrigatoria para iniciar job de remocao.");
  }
  const resolvedAccountLabel =
    String(accountLabel || resolvedAccountKey).trim() || resolvedAccountKey;

  const queue = getQueue();
  const customJobId = makeRemoveJobId();
  const job = await queue.add(
    {
      mlbIds,
      delayMs,
      mlCreds,
      accountKey: resolvedAccountKey,
      accountLabel: resolvedAccountLabel,
      auditContext,
      createdAt: Date.now(),
    },
    {
      jobId: customJobId,
      attempts: 1,
      removeOnComplete: 30,
      removeOnFail: false,
    },
  );

  return { id: String(job.id) };
}

async function listRecent(limit = 25, { accountKey = null } = {}) {
  const queue = getQueue();
  const jobs = await queue.getJobs(
    ["active", "waiting", "delayed", "failed", "completed"],
    0,
    Math.max(0, Number(limit || 25) - 1),
    false,
  );
  const scoped = jobs.filter((job) => canAccessJob(job, accountKey));
  const mapped = await Promise.all(scoped.map(mapJob));
  return mapped.filter(Boolean);
}

async function jobDetail(id, { accountKey = null } = {}) {
  const queue = getQueue();
  const job = await queue.getJob(String(id));
  if (!job) return null;
  if (!canAccessJob(job, accountKey)) return null;
  return mapJob(job);
}

async function cancelJob(id, { accountKey = null } = {}) {
  const queue = getQueue();
  const job = await queue.getJob(String(id));
  if (!job) return null;
  if (!canAccessJob(job, accountKey)) return null;

  const state = await job.getState().catch(() => "unknown");
  if (state === "completed" || state === "failed") {
    await auditRemoveJobEvent(job, "promotion_job_cancel_rejected", "warn", {
      current_state: state,
    });
    return { ok: false, status: state, error: "Job ja finalizado." };
  }

  if (state === "waiting" || state === "delayed") {
    await updateMeta(job, {
      status: "cancelado",
      finishedAt: Date.now(),
      updatedAt: Date.now(),
      cancelRequested: false,
    });
    await job.remove();
    await auditRemoveJobEvent(job, "promotion_job_canceled", "warn", {
      current_state: state,
    });
    return { ok: true, status: "cancelado" };
  }

  await updateMeta(job, {
    status: "cancelando",
    cancelRequested: true,
    updatedAt: Date.now(),
  });
  await auditRemoveJobEvent(job, "promotion_job_cancel_requested", "warn", {
    current_state: state,
  });
  return { ok: true, status: "cancelando" };
}

async function removeOne({ mlCreds, promotion_id, promotion_type, item_id }) {
  try {
    const res = await removeOneDirect({
      mlb: item_id,
      mlCreds,
      accountKey: mlCreds?.account_key || null,
      promotion_id,
      promotion_type,
    });
    return {
      ok: !!res.ok,
      status: res.status ?? (res.ok ? 200 : 400),
      body: res.body ?? null,
      error: res.error || null,
    };
  } catch (e) {
    return { ok: false, status: 500, error: e?.message || String(e) };
  }
}

function initWorker() {
  const queue = getQueue();
  if (workerStarted) return queue;

  workerStarted = true;
  queue.process(1, async (job) => {
    try {
      return await runJob(job);
    } catch (error) {
      if (error instanceof JobCancelledError) {
        await updateMeta(job, {
          status: "cancelado",
          finishedAt: Date.now(),
          updatedAt: Date.now(),
          cancelRequested: false,
        });
        await job.progress(100);
        await auditRemoveJobEvent(job, "promotion_job_canceled", "warn", {
          total_items: Number(job.data?.__meta?.total ?? job.data?.mlbIds?.length ?? 0),
          success: Number(job.data?.__meta?.success ?? 0),
          failed: Number(job.data?.__meta?.failed ?? 0),
        });
        return {
          ok: false,
          cancelled: true,
          total: Number(job.data?.__meta?.total ?? job.data?.mlbIds?.length ?? 0),
          success: Number(job.data?.__meta?.success ?? 0),
          failed: Number(job.data?.__meta?.failed ?? 0),
          failedItems: Array.isArray(job.data?.__meta?.failedItems)
            ? job.data.__meta.failedItems
            : [],
          results: Array.isArray(job.data?.__meta?.results)
            ? job.data.__meta.results
            : [],
        };
      }
      await auditRemoveJobEvent(job, "promotion_job_failed", "error", {
        total_items: Number(job.data?.__meta?.total ?? job.data?.mlbIds?.length ?? 0),
        processed: Number(job.data?.__meta?.processed ?? 0),
        success: Number(job.data?.__meta?.success ?? 0),
        failed: Number(job.data?.__meta?.failed ?? 0),
        error: safeText(error?.message || String(error)),
      });
      throw error;
    }
  });
  queue.on("failed", (job, err) => {
    console.error("[PromoBulkRemoveAdapter] job failed:", job?.id, err?.message || err);
  });
  queue.on("completed", (job) => {
    console.log("[PromoBulkRemoveAdapter] job completed:", job?.id);
  });

  console.log("[PromoBulkRemoveAdapter] worker iniciado");
  return queue;
}

module.exports = {
  initWorker,
  startRemoveJob,
  listRecent,
  jobDetail,
  cancelJob,
  getJobCsv,
  removeOne,
};
