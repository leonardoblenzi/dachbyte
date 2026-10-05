"use strict";

const Bull = require("bull");
const crypto = require("crypto");
const { makeBullClient } = require("../lib/redisClient");
const { analyzeStock, buildCsvRows, CSV_HEADER } = require("./estoqueAlertaService");
const { buildCsv, attachJobReview } = require("./jobReviewHelper");
const { recordAuthEvent } = require("./authAuditService");
const { quoteCredits, reserveCredits, settleCredits } = require("./hubCreditsService");

const QUEUE_NAME = "estoque-alerta-queue";
const RECENT_LIMIT = 30;
let queueInstance = null;
let workerStarted = false;

function getQueue() {
  if (!queueInstance) {
    queueInstance = new Bull(QUEUE_NAME, {
      createClient: (type) => makeBullClient(type, QUEUE_NAME),
    });
    queueInstance.on("error", (error) => {
      console.error("[EstoqueAlertaQueue] erro na fila:", error?.message || error);
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
  if (!wanted || !current) return false;
  return wanted === current;
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
  } catch {
    // Bull v3 can expose progress synchronously depending on the job instance.
  }
  return job?._progress || 0;
}

function positiveNumber(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeScanQuantity(value) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function stockScanIdempotencyKey(operationId) {
  const id = String(operationId || "").trim();
  if (!id) throw new Error("stock_scan_operation_id_required");
  return `stock.scan:${id}`;
}

function stockScanBillableUnits(job = {}, meta = {}, result = null) {
  const resolved = result || job?.returnvalue || {};
  return Math.max(
    0,
    Number(meta?.ok ?? resolved?.total ?? resolved?.processed ?? 0) || 0,
  );
}

function stockScanTelemetry(job = {}, meta = {}, result = null) {
  const reservation = job?.data?.creditReservation || {};
  const billableUnits = stockScanBillableUnits(job, meta, result);
  return {
    billing_mode:
      !reservation || Object.keys(reservation).length === 0
        ? "pending"
        : reservation?.shadow === true
          ? "shadow"
          : reservation?.bypass === true
            ? "bypass"
            : "enforce",
    operation_key: "stock.scan",
    operation_id: job?.data?.operationId || null,
    selected: Math.max(0, Number(meta?.total || result?.total || 0)),
    processed: Math.max(0, Number(meta?.processed || result?.processed || 0)),
    successful: Math.max(0, Number(meta?.ok || result?.total || 0)),
    errors: Math.max(0, Number(meta?.errors || result?.errors || 0)),
    billable_units: billableUnits,
    estimated_credits:
      reservation?.quote?.estimated_credits ??
      reservation?.reserved_credits ??
      null,
    duration_ms:
      meta?.startedAt && (meta?.finishedAt || meta?.failedAt)
        ? Math.max(0, Number(meta.finishedAt || meta.failedAt) - Number(meta.startedAt))
        : null,
  };
}

function auditBase(job = {}) {
  const context = job?.data?.auditContext || {};
  return {
    userId: Number(context.userId) || null,
    email: context.email || null,
    ip: context.ip || null,
    userAgent: context.userAgent || null,
    accountKey: context.accountKey || job?.data?.accountKey || null,
    accountLabel: context.accountLabel || job?.data?.accountLabel || null,
    meli_conta_id: context.meli_conta_id || job?.data?.mlCreds?.meli_conta_id || null,
  };
}

async function auditStockScan(job, evento, status, metadata = {}) {
  const actor = auditBase(job);
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
      operation_id: job?.data?.operationId || null,
      action: "stock_scan",
      ...metadata,
    },
  }).catch((error) => {
    console.error("[EstoqueAlertaQueue] audit erro:", error?.message || error);
  });
}

async function ensureStockScanReservation(job, units) {
  const quantity = Math.max(0, Math.trunc(Number(units) || 0));
  if (!quantity) return job?.data?.creditReservation || null;
  if (job?.data?.creditReservation) return job.data.creditReservation;

  const reservation = await reserveCredits({
    mlCreds: job?.data?.mlCreds || {},
    operationKey: "stock.scan",
    units: quantity,
    idempotencyKey: stockScanIdempotencyKey(job?.data?.operationId || String(job?.id || "")),
  });
  job.data.creditReservation = reservation;
  await job.update(job.data);
  return reservation;
}

function serializeError(error) {
  return {
    message: error?.message || String(error || "Falha desconhecida."),
    statusCode: error?.statusCode || error?.status || null,
    details: error?.details || null,
  };
}

function resolveMetrics(job, state) {
  const meta = job?.data?.__meta || {};
  const result = state === "completed" ? (job?.returnvalue || {}) : (job?.returnvalue || {});
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const total = Math.max(positiveNumber(meta.total), positiveNumber(result.total), rows.length);
  const processed = Math.max(positiveNumber(meta.processed), positiveNumber(result.processed), rows.length);
  const errors = Math.max(positiveNumber(meta.errors), positiveNumber(result.errors));
  const ok = Math.max(positiveNumber(meta.ok), total > 0 ? Math.max(0, processed - errors) : rows.length);
  return { total, processed, errors, ok, rows };
}

async function processJob(job) {
  console.log("[EstoqueAlertaQueue] processor picked job:", job?.id, {
    accountKey: job?.data?.accountKey || null,
    source: job?.data?.source || "sold_period",
    periodDays: job?.data?.periodDays || 30,
    maxItems: job?.data?.maxItems ?? null,
    hasAccessToken: !!job?.data?.accessToken,
    hasCredToken: !!job?.data?.mlCreds?.access_token,
  });
  const startedAt = Date.now();

  let result = null;
  try {
    await setJobProgress(job, 1);
    job.data.__meta = { total: 0, processed: 0, ok: 0, errors: 0, startedAt, phase: "starting" };
    await job.update(job.data);
    await auditStockScan(job, "stock_scan_job_started", "success", {
      source: job?.data?.source || "sold_period",
      max_items: job?.data?.maxItems ?? null,
      period_days: job?.data?.periodDays || 30,
    });

    result = await analyzeStock({
      accessToken: job.data.accessToken,
      mlCreds: job.data.mlCreds || {},
      accountKey: job.data.accountKey,
      accountLabel: job.data.accountLabel,
      source: job.data.source || "sold_period",
      query: job.data.query || "",
      maxItems: job.data.maxItems ?? null,
      periodDays: job.data.periodDays || 30,
      customFrom: job.data.customFrom || null,
      customTo: job.data.customTo || null,
      onProgress: async (progress) => {
        const total = Number(progress.total || job.data.__meta?.total || 0);
        const processed = Number(progress.processed || 0);
        if (progress.phase === "details" && total > 0) {
          await ensureStockScanReservation(job, total);
        }
        let pct = Number(job._progress || 1);
        if (progress.phase === "auth") pct = Math.max(pct, 3);
        if (progress.phase === "seller") pct = Math.max(pct, 5);
        if (progress.phase === "listing") pct = Math.max(pct, 8);
        if (progress.phase === "orders") pct = Math.max(pct, 35);
        if (progress.phase === "details") pct = Math.max(pct, 45);
        if (progress.phase === "metrics" && total > 0) pct = 45 + Math.round((processed / total) * 50);
        job.data.__meta = {
          ...(job.data.__meta || {}),
          total: total || job.data.__meta?.total || 0,
          processed: processed || job.data.__meta?.processed || 0,
          ok: processed || job.data.__meta?.ok || 0,
          errors: 0,
          phase: progress.phase,
          updatedAt: Date.now(),
        };
        await job.update(job.data);
        await setJobProgress(job, pct);
      },
    });
  } catch (error) {
    const serialized = serializeError(error);
    job.data.__meta = {
      ...(job.data.__meta || {}),
      errors: Math.max(1, Number(job.data.__meta?.errors || 0)),
      error: serialized.message,
      errorDetails: serialized.details,
      statusCode: serialized.statusCode,
      failedAt: Date.now(),
    };
    await job.update(job.data).catch(() => {});
    await auditStockScan(job, "stock_scan_job_failed", "error", {
      source: job?.data?.source || "sold_period",
      error: serialized.message,
      billing_telemetry: stockScanTelemetry(job, job.data.__meta || {}, result),
    });
    console.error("[EstoqueAlertaQueue] job failed with context:", job?.id, {
      phase: job.data.__meta?.phase || null,
      accountKey: job?.data?.accountKey || null,
      source: job?.data?.source || "sold_period",
      hasAccessToken: !!job?.data?.accessToken,
      hasCredToken: !!job?.data?.mlCreds?.access_token,
      message: serialized.message,
      statusCode: serialized.statusCode,
      details: serialized.details,
    });
    throw error;
  }

  job.data.__meta = {
    ...(job.data.__meta || {}),
    total: result.total,
    processed: result.total,
    ok: result.total,
    errors: 0,
    finishedAt: Date.now(),
  };
  await job.update(job.data);
  await setJobProgress(job, 100);
  await auditStockScan(job, "stock_scan_job_completed", "success", {
    source: job?.data?.source || "sold_period",
    total_items: Number(result.total || 0),
    orders_scanned: Number(result.orders_scanned || 0),
    billing_telemetry: stockScanTelemetry(job, job.data.__meta || {}, result),
  });
  return { ...result, processed: result.total, errors: 0 };
}

function normalizeState(state) {
  const text = String(state || "").toLowerCase();
  if (text === "completed") return "concluido";
  if (text === "failed") return "erro";
  if (text === "active") return "processando";
  if (text === "waiting" || text === "delayed") return "aguardando";
  return text || "processando";
}

async function jobToPayload(job) {
  if (!job) return null;
  const state = await job.getState().catch(() => "unknown");
  const progressRaw = await getJobProgress(job);
  const metrics = resolveMetrics(job, state);
  const completed = state === "completed";
  const failed = state === "failed";
  const errorMessage =
    job.data?.__meta?.error ||
    job.failedReason ||
    (failed ? "Falha ao processar analise de estoque." : null);
  const base = {
    id: String(job.id),
    title: job.data?.title || "Estoque - alerta",
    state: normalizeState(state),
    status: normalizeState(state),
    progress: completed ? 100 : Math.max(0, Math.min(100, Number(progressRaw || 0))),
    processed: metrics.processed,
    total: metrics.total,
    errors: failed ? Math.max(1, metrics.errors) : metrics.errors,
    error: errorMessage,
    failedReason: errorMessage,
    details: job.data?.__meta?.errorDetails || null,
    phase: job.data?.__meta?.phase || null,
    statusCode: job.data?.__meta?.statusCode || null,
    completed: completed || failed,
    created_at: job.timestamp ? new Date(job.timestamp).toISOString() : null,
    updated_at: new Date(job.processedOn || job.finishedOn || Date.now()).toISOString(),
    account: {
      key: job.data?.accountKey || null,
      label: job.data?.accountLabel || null,
    },
    source: job.data?.source || null,
    billing_telemetry: stockScanTelemetry(job, job.data?.__meta || {}, job.returnvalue || null),
    result: completed ? { total: metrics.total, summary: job.returnvalue?.summary || null } : null,
  };
  return attachJobReview(base, {
    completed: base.completed,
    errors: base.errors,
    hasCsv: completed && metrics.rows.length > 0,
    basePath: "/api/estoque/alerta/jobs",
    label: "Baixar CSV",
  });
}

async function findOpenJob(queue, { accountKey, source } = {}) {
  const wantedAccount = normalizeAccountKey(accountKey);
  const wantedSource = String(source || "sold_period");
  if (!wantedAccount) return null;
  const jobs = await queue.getJobs(["active", "waiting", "delayed"], 0, 50, false);
  for (const job of jobs) {
    const currentAccount = normalizeAccountKey(job?.data?.accountKey);
    const currentSource = String(job?.data?.source || "sold_period");
    if (currentAccount === wantedAccount && currentSource === wantedSource) return job;
  }
  return null;
}

async function enqueueStockJob({
  accessToken,
  mlCreds = {},
  accountKey,
  accountLabel,
  source = "sold_period",
  query = "",
  maxItems = null,
  periodDays = 30,
  customFrom = null,
  customTo = null,
  auditContext = null,
} = {}) {
  const queue = getQueue();
  const existing = await findOpenJob(queue, { accountKey, source });
  if (existing) return String(existing.id);

  const operationId = `STOCK-SCAN-${crypto.randomUUID()}`;
  const plannedQuantity = normalizeScanQuantity(maxItems);
  const creditReservation = plannedQuantity
    ? await reserveCredits({
        mlCreds,
        operationKey: "stock.scan",
        units: plannedQuantity,
        idempotencyKey: stockScanIdempotencyKey(operationId),
      })
    : null;
  let job;
  try {
    job = await queue.add(
      {
        title: source === "sold_period" ? "Estoque - vendidos no periodo" : "Estoque - itens selecionados",
        accessToken,
        mlCreds,
        accountKey,
        accountLabel,
        source,
        query,
        maxItems,
        periodDays,
        customFrom,
        customTo,
        auditContext: auditContext && typeof auditContext === "object" ? auditContext : null,
        creditReservation,
        operationId,
      },
      {
        attempts: 1,
        removeOnComplete: { age: 60 * 60 * 24 * 3, count: 80 },
        removeOnFail: { age: 60 * 60 * 24 * 3, count: 80 },
      },
    );
  } catch (error) {
    await settleCredits(creditReservation, { release: true });
    throw error;
  }
  return String(job.id);
}

function initWorker() {
  if (workerStarted) return getQueue();
  workerStarted = true;
  const queue = getQueue();
  queue.resume().catch((error) => {
    console.error("[EstoqueAlertaQueue] falha ao retomar fila:", error?.message || error);
  });
  queue.process(1, processJob);
  queue.on("active", (job) => console.log("[EstoqueAlertaQueue] job active:", job?.id));
  queue.on("completed", async (job) => {
    console.log("[EstoqueAlertaQueue] job completed:", job?.id);
    const metrics = resolveMetrics(job, "completed");
    const billableUnits = stockScanBillableUnits(job, job?.data?.__meta || {}, job?.returnvalue || null);
    await settleCredits(job?.data?.creditReservation, {
      release: billableUnits <= 0,
      consumedUnits: billableUnits > 0 ? billableUnits : null,
    });
  });
  queue.on("failed", async (job, error) => {
    console.error("[EstoqueAlertaQueue] job failed:", job?.id, error?.message || error);
    const metrics = resolveMetrics(job, "failed");
    const billableUnits = stockScanBillableUnits(job, job?.data?.__meta || {}, job?.returnvalue || null);
    await settleCredits(job?.data?.creditReservation, {
      release: billableUnits <= 0,
      consumedUnits: billableUnits > 0 ? billableUnits : null,
    });
  });
  queue.on("stalled", (job) => console.warn("[EstoqueAlertaQueue] job stalled:", job?.id));
  console.log("[EstoqueAlertaQueue] worker iniciado");
  return queue;
}

async function previewStockScanCredits({ mlCreds = {}, account = null, maxItems = null } = {}) {
  const quantity = normalizeScanQuantity(maxItems);
  if (!quantity) {
    return {
      operation_key: "stock.scan",
      quantity: null,
      estimated_credits: null,
      available_credits: null,
      sufficient: true,
      unlimited: false,
      deferred: true,
    };
  }
  const quote = await quoteCredits({
    mlCreds,
    account,
    operationKey: "stock.scan",
    units: quantity,
  });
  return {
    operation_key: "stock.scan",
    quantity,
    estimated_credits: Number(quote?.estimated_credits || 0),
    available_credits: quote?.available_credits == null ? null : Number(quote.available_credits),
    sufficient: quote?.sufficient !== false,
    unlimited: quote?.unlimited === true,
    deferred: false,
    quote,
  };
}

async function analyzeStockWithCredits({
  accessToken,
  mlCreds = {},
  accountKey,
  accountLabel,
  auditContext = null,
  source = "manual",
  query = "",
  maxItems = null,
  periodDays = 30,
  customFrom = null,
  customTo = null,
} = {}) {
  const operationId = `STOCK-SCAN-${crypto.randomUUID()}`;
  let reservation = null;
  let total = 0;
  let processed = 0;
  const startedAt = Date.now();

  const pseudoJob = {
    id: operationId,
    data: {
      accountKey,
      accountLabel,
      mlCreds,
      auditContext,
      source,
      maxItems,
      periodDays,
      operationId,
      creditReservation: null,
    },
  };

  try {
    await auditStockScan(pseudoJob, "stock_scan_direct_started", "success", {
      source,
      max_items: maxItems,
      period_days: periodDays,
    });
    const planned = normalizeScanQuantity(maxItems);
    if (planned) {
      reservation = await reserveCredits({
        mlCreds,
        operationKey: "stock.scan",
        units: planned,
        idempotencyKey: stockScanIdempotencyKey(operationId),
      });
      pseudoJob.data.creditReservation = reservation;
    }

    const payload = await analyzeStock({
      accessToken,
      mlCreds,
      accountKey,
      accountLabel,
      source,
      query,
      maxItems,
      periodDays,
      customFrom,
      customTo,
      onProgress: async (progress = {}) => {
        total = Math.max(total, Number(progress.total || 0));
        if (progress.phase === "details" && total > 0 && !reservation) {
          reservation = await reserveCredits({
            mlCreds,
            operationKey: "stock.scan",
            units: total,
            idempotencyKey: stockScanIdempotencyKey(operationId),
          });
          pseudoJob.data.creditReservation = reservation;
        }
        if (progress.phase === "metrics") {
          processed = Math.max(processed, Number(progress.processed || 0));
        }
      },
    });

    total = Number(payload?.total || total || 0);
    processed = total;
    await settleCredits(reservation, {
      release: total <= 0,
      consumedUnits: total > 0 ? total : null,
    });
    const finalMeta = { total, processed, ok: total, errors: 0, startedAt, finishedAt: Date.now() };
    const billingTelemetry = stockScanTelemetry(pseudoJob, finalMeta, payload);
    await auditStockScan(pseudoJob, "stock_scan_direct_completed", "success", {
      source,
      total_items: total,
      orders_scanned: Number(payload?.orders_scanned || 0),
      billing_telemetry: billingTelemetry,
    });
    return {
      ...payload,
      billing_telemetry: billingTelemetry,
    };
  } catch (error) {
    await settleCredits(reservation, {
      release: processed <= 0,
      consumedUnits: processed > 0 ? processed : null,
    });
    await auditStockScan(pseudoJob, "stock_scan_direct_failed", "error", {
      source,
      error: error?.message || String(error),
      billing_telemetry: stockScanTelemetry(
        pseudoJob,
        { total, processed, ok: processed, errors: 1, startedAt, failedAt: Date.now() },
        null,
      ),
    });
    throw error;
  }
}

async function listStockJobs(limit = RECENT_LIMIT, { accountKey } = {}) {
  const queue = getQueue();
  const jobs = await queue.getJobs(["active", "waiting", "delayed", "completed", "failed"], 0, Math.max(1, limit) - 1, false);
  const list = [];
  for (const job of jobs) {
    if (!canAccessJob(job, accountKey)) continue;
    const payload = await jobToPayload(job);
    if (payload) list.push(payload);
  }
  return list.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
}

async function getStockJobDetail(id, { accountKey } = {}) {
  const job = await getQueue().getJob(id);
  if (!job || !canAccessJob(job, accountKey)) return null;
  const payload = await jobToPayload(job);
  const state = await job.getState().catch(() => "unknown");
  return {
    ...payload,
    rows: state === "completed" && Array.isArray(job.returnvalue?.rows) ? job.returnvalue.rows : [],
    insights: state === "completed" ? job.returnvalue?.insights || [] : [],
    summary: state === "completed" ? job.returnvalue?.summary || null : null,
  };
}

async function getStockJobCsv(id, { accountKey } = {}) {
  const detail = await getStockJobDetail(id, { accountKey });
  if (!detail?.rows?.length) return null;
  return {
    filename: `alerta_estoque_${id}.csv`,
    csv: buildCsv(buildCsvRows(detail.rows), CSV_HEADER),
  };
}

async function cancelStockJob(id, { accountKey } = {}) {
  const job = await getQueue().getJob(id);
  if (!job || !canAccessJob(job, accountKey)) return null;
  const state = await job.getState().catch(() => "unknown");
  if (["completed", "failed"].includes(state)) return { ok: false, status: state, error: "Job ja finalizado." };
  await settleCredits(job?.data?.creditReservation, { release: true });
  await job.remove();
  return { ok: true, status: "cancelado" };
}

module.exports = {
  enqueueStockJob,
  initWorker,
  listStockJobs,
  getStockJobDetail,
  getStockJobCsv,
  cancelStockJob,
  previewStockScanCredits,
  analyzeStockWithCredits,
  _test: {
    normalizeScanQuantity,
    stockScanIdempotencyKey,
    stockScanBillableUnits,
    stockScanTelemetry,
  },
};
