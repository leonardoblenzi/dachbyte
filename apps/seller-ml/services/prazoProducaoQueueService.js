"use strict";

const Bull = require("bull");
const { makeBullClient, getSharedRedis } = require("../lib/redisClient");
const {
  updatePrazoProducao,
  consultPrazoItemRow,
  summarizePrazoRows,
  listActiveSellerItemIds,
  prepareAuthState,
  normMlb,
  clampInt,
} = require("./prazoProducaoService");
const { buildCsv, attachJobReview } = require("./jobReviewHelper");
const { attachJobContract, backendJobIdFromUid } = require("./jobContract");
const { recordAuthEvent } = require("./authAuditService");
const { reserveCredits, settleCredits } = require("./hubCreditsService");

function resolveJobId(value) {
  return backendJobIdFromUid("prazo", value);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function setJobProgress(job, value) {
  const progress = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  if (typeof job?.progress === "function") {
    return job.progress(progress);
  }
  if (typeof job?.updateProgress === "function") {
    return job.updateProgress(progress);
  }
  job._progress = progress;
  return progress;
}

let queueInstance = null;
let workerStarted = false;
const QUEUE_NAME = "prazo-producao-queue";
const TTL_SECONDS = Math.max(
  3600,
  Number(process.env.PRAZO_PRODUCAO_TTL_SECONDS || 6 * 60 * 60),
);

let redisClient = null;

function getRedis() {
  if (!redisClient) redisClient = getSharedRedis("app");
  return redisClient;
}

function resultsKey(jobId) {
  return `ml:prazo-producao:${jobId}:results`;
}

async function readJsonKey(key) {
  try {
    const raw = await getRedis().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function writeJsonKey(key, payload) {
  await getRedis().set(key, JSON.stringify(payload), "EX", TTL_SECONDS);
}

async function writeResults(jobId, rows) {
  await writeJsonKey(resultsKey(jobId), Array.isArray(rows) ? rows : []);
}

async function readResults(job) {
  const stored = await readJsonKey(resultsKey(job?.id));
  if (Array.isArray(stored)) return stored;
  if (Array.isArray(job?.data?.__meta?.results)) return job.data.__meta.results;
  if (Array.isArray(job?.returnvalue?.results)) return job.returnvalue.results;
  if (Array.isArray(job?.returnvalue?.rows)) return job.returnvalue.rows;
  return [];
}

class JobCancelledError extends Error {
  constructor(message = "Job cancelado pelo usuario.") {
    super(message);
    this.name = "JobCancelledError";
  }
}

function normalizeAccountKey(value) {
  const text = String(value || "").trim();
  return text || null;
}

function canAccessJob(job, accountKey) {
  const wanted = normalizeAccountKey(accountKey);
  const current = normalizeAccountKey(job?.data?.accountKey);
  if (!wanted) return false;
  if (!current) return false;
  if (current === "default") return false;
  return current === wanted;
}

function getQueue() {
  if (!queueInstance) {
    queueInstance = new Bull(QUEUE_NAME, {
      createClient: (type) => makeBullClient(type, QUEUE_NAME),
    });
  }
  return queueInstance;
}

function positiveNumber(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function pickArray(...values) {
  return values.find((value) => Array.isArray(value)) || [];
}

function countPrazoResultRows(rows, wanted) {
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((count, row) => {
    if (wanted === "success") return row?.success === true ? count + 1 : count;
    return row?.success === false ? count + 1 : count;
  }, 0);
}

function safeText(value, max = 500) {
  const text = value == null ? "" : String(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function prazoAuditBase(job = {}) {
  const context = job?.data?.auditContext || {};
  return {
    userId: Number(context.userId) || null,
    email: context.email || null,
    ip: context.ip || null,
    userAgent: context.userAgent || null,
    accountKey: context.accountKey || job?.data?.accountKey || null,
    accountLabel: context.accountLabel || job?.data?.accountLabel || job?.data?.accountKey || null,
    meli_conta_id: context.meli_conta_id || job?.data?.mlCreds?.meli_conta_id || null,
    route: context.route || null,
    method: context.method || null,
  };
}

async function auditPrazoJobEvent(job, evento, status, metadata = {}) {
  const base = prazoAuditBase(job);
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
      job_id: String(job?.id || ""),
      action: "update_production_time",
      ...metadata,
    },
  }).catch((err) => {
    console.error("[prazo-producao] audit erro:", err?.message || err);
  });
}

function prazoTermDays(term) {
  const value = Number(term?.value_struct?.number);
  return Number.isFinite(value) ? value : null;
}

function resolvePrazoJobMetrics(job, meta = {}) {
  const result = job?.returnvalue || {};
  const results = pickArray(meta.results, result.results);
  const successFromRows = countPrazoResultRows(results, "success");
  const failedFromRows = countPrazoResultRows(results, "failed");
  const processedFromRows = successFromRows + failedFromRows;
  const resultsCount = Math.max(
    positiveNumber(meta.resultsCount),
    positiveNumber(result.results_count),
    results.length,
  );
  const processed = Math.max(
    positiveNumber(meta.processed),
    positiveNumber(result.processed),
    processedFromRows,
  );
  const total = Math.max(
    positiveNumber(meta.total),
    positiveNumber(result.total),
    processed,
    Array.isArray(job?.data?.mlb_ids) ? job.data.mlb_ids.length : 0,
  );
  const success = Math.max(
    positiveNumber(meta.ok),
    positiveNumber(result.ok),
    successFromRows,
  );
  const failed = Math.max(
    positiveNumber(meta.err),
    positiveNumber(result.err),
    failedFromRows,
  );

  return { total, processed, success, failed, results, resultsCount };
}

async function processPrazoJob(job) {
  if (job.data?.type === "lookup_active") {
    return processPrazoLookupActiveJob(job);
  }

  const startedAt = Date.now();

  const accessToken = job.data?.accessToken;
  const mlCreds = job.data?.mlCreds || {};
  const days = clampInt(job.data?.days, 0, 365);
  const delayMs = clampInt(job.data?.delayMs, 0, 10000) ?? 250;

  const raw = Array.isArray(job.data?.mlb_ids) ? job.data.mlb_ids : [];
  const items = raw.map(normMlb).filter(Boolean);

  const total = items.length || 0;
  let ok = 0;
  let err = 0;

  // meta pro status
  await setJobProgress(job, 0);
  await job.log(`Iniciado: total=${total}, days=${days}, delayMs=${delayMs}`);
  await auditPrazoJobEvent(job, "production_time_job_started", "success", {
    total_items: total,
    sample_ids: items.slice(0, 20),
    requested_days: days,
    delay_ms: delayMs,
  });

  const results = []; // se quiser manter (cuidado com tamanho)
  const authState = await prepareAuthState({ accessToken, mlCreds });

  for (let i = 0; i < items.length; i++) {
    if (job.data?.__meta?.cancelRequested) {
      throw new JobCancelledError();
    }
    const mlbId = items[i];

    try {
      const updateResult = await updatePrazoProducao({
        accessToken,
        authState,
        mlbId,
        days,
        verify: true,
      });
      ok++;
      const row = {
        mlb_id: mlbId,
        success: true,
        title: updateResult?.title || null,
        requested_days: days,
        previous_days: prazoTermDays(updateResult?.manufacturing_before),
        applied_days: prazoTermDays(updateResult?.manufacturing_after),
        previous_value: updateResult?.manufacturing_before || null,
        applied_value: updateResult?.manufacturing_after || null,
        ml_response: updateResult?.put_result || null,
      };
      results.push(row);
      await auditPrazoJobEvent(job, "production_time_item_processed", "success", {
        mlb_id: mlbId,
        item_id: mlbId,
        item_index: i + 1,
        total_items: total,
        requested_days: days,
        previous_days: row.previous_days,
        applied_days: row.applied_days,
        previous_value: row.previous_value,
        applied_value: row.applied_value,
        ml_status: 200,
        message: "Prazo de producao atualizado.",
      });
    } catch (e) {
      err++;
      const row = {
        mlb_id: mlbId,
        success: false,
        error: e?.message || "erro",
        requested_days: days,
        ml_status: e?.statusCode || null,
        ml_response: e?.details || null,
      };
      results.push(row);
      await auditPrazoJobEvent(job, "production_time_item_processed", "error", {
        mlb_id: mlbId,
        item_id: mlbId,
        item_index: i + 1,
        total_items: total,
        requested_days: days,
        ml_status: row.ml_status,
        ml_body: row.ml_response,
        error: safeText(row.error),
        message: safeText(row.error),
      });
    }

    const processed = i + 1;
    const pct = total > 0 ? Math.round((processed / total) * 100) : 100;

    // salva contadores no job (pra status endpoint ler)
    job.data.__meta = {
      total,
      processed,
      ok,
      err,
      resultsCount: results.length,
      startedAt,
      updatedAt: Date.now(),
    };

    await job.update(job.data);
    await setJobProgress(job, pct);

    if (delayMs > 0 && processed < total) await sleep(delayMs);
  }

  job.data.__meta = {
    total,
    processed: total,
    ok,
    err,
    resultsCount: results.length,
    startedAt,
    finishedAt: Date.now(),
  };
  await writeResults(job.id, results);
  await job.update(job.data);
  await setJobProgress(job, 100);
  await auditPrazoJobEvent(job, "production_time_job_completed", err > 0 ? "warn" : "success", {
    total_items: total,
    processed: total,
    success_count: ok,
    error_count: err,
    requested_days: days,
  });

  return {
    ok,
    err,
    total,
    results_count: results.length,
  };
}

async function processPrazoLookupActiveJob(job) {
  const startedAt = Date.now();
  const accessToken = job.data?.accessToken;
  const mlCreds = job.data?.mlCreds || {};
  const maxItems =
    job.data?.maxItems === null || job.data?.maxItems === undefined
      ? null
      : clampInt(job.data?.maxItems, 1, 50000);
  const authState = await prepareAuthState({ accessToken, mlCreds });

  await setJobProgress(job, 0);
  await job.log("Listando anuncios ativos da conta.");
  job.data.__meta = {
    total: 0,
    processed: 0,
    ok: 0,
    err: 0,
    resultsCount: 0,
    status: "listando ativos",
    startedAt,
    updatedAt: Date.now(),
  };
  await job.update(job.data);

  const listing = await listActiveSellerItemIds({
    authState,
    mlCreds,
    maxItems,
    onProgress: async ({ listed }) => {
      job.data.__meta = {
        ...(job.data.__meta || {}),
        total: listed,
        processed: 0,
        ok: 0,
        err: 0,
        status: "listando ativos",
        updatedAt: Date.now(),
      };
      await job.update(job.data);
      await setJobProgress(job, 1);
    },
  });
  const { sellerId, ids } = listing;

  const total = ids.length;
  const results = new Array(total);
  let processed = 0;
  let ok = 0;
  let err = 0;
  let nextIndex = 0;
  const concurrency = Math.min(6, Math.max(1, Number(job.data?.concurrency || 6)));

  job.data.__meta = {
    ...(job.data.__meta || {}),
    sellerId,
    source: listing.source || null,
    totalAvailable: listing.totalAvailable || null,
    truncated: listing.truncated === true,
    scanError: listing.scanError || null,
    total,
    processed: 0,
    ok: 0,
    err: 0,
    resultsCount: 0,
    status: "consultando prazos",
    updatedAt: Date.now(),
  };
  await job.update(job.data);
  await setJobProgress(job, total > 0 ? 2 : 100);

  async function worker() {
    for (;;) {
      if (job.data?.__meta?.cancelRequested) {
        throw new JobCancelledError();
      }
      const index = nextIndex;
      nextIndex += 1;
      if (index >= total) return;

      const row = await consultPrazoItemRow({ authState, mlbId: ids[index] });
      results[index] = row;
      processed += 1;
      if (row?.success) ok += 1;
      else err += 1;

      const pct = total > 0 ? Math.max(2, Math.round((processed / total) * 100)) : 100;
      job.data.__meta = {
        ...(job.data.__meta || {}),
        total,
        processed,
        ok,
        err,
        resultsCount: processed,
        status: "consultando prazos",
        updatedAt: Date.now(),
      };
      await job.update(job.data);
      await setJobProgress(job, pct);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(total, 1)) }, () => worker())
  );

  const rows = results.filter(Boolean);
  const summary = summarizePrazoRows(rows);
  delete summary.rows;
  job.data.__meta = {
    ...(job.data.__meta || {}),
    sellerId,
    source: listing.source || null,
    totalAvailable: listing.totalAvailable || null,
    truncated: listing.truncated === true,
    scanError: listing.scanError || null,
    total,
    processed: total,
    ok,
    err,
    resultsCount: rows.length,
    status: "concluido",
    finishedAt: Date.now(),
  };
  await writeResults(job.id, rows);
  await job.update(job.data);
  await setJobProgress(job, 100);

  return {
    ...summary,
    ok,
    err,
    seller_id: sellerId,
    results_count: rows.length,
  };
}

function initWorker() {
  const queue = getQueue();
  if (workerStarted) return queue;

  workerStarted = true;
  queue.process(async (job) => {
    try {
      return await processPrazoJob(job);
    } catch (error) {
      if (error instanceof JobCancelledError) {
        job.data.__meta = {
          ...(job.data.__meta || {}),
          status: "cancelado",
          cancelRequested: false,
          finishedAt: Date.now(),
        };
        await job.update(job.data);
        await setJobProgress(job, 100);
        return {
          ok: false,
          cancelled: true,
          total: Number(job.data?.__meta?.total ?? job.data?.mlb_ids?.length ?? 0),
          err: Number(job.data?.__meta?.err ?? 0),
          results: [],
        };
      }
      job.data.__meta = {
        ...(job.data.__meta || {}),
        status: "erro",
        error: error?.message || "Falha inesperada no job.",
        err: Math.max(1, Number(job.data?.__meta?.err || 0)),
        finishedAt: Date.now(),
        updatedAt: Date.now(),
      };
      await job.update(job.data).catch(() => {});
      await setJobProgress(job, 100).catch(() => {});
      await auditPrazoJobEvent(job, "production_time_job_failed", "error", {
        total_items: Number(job.data?.__meta?.total ?? job.data?.mlb_ids?.length ?? 0),
        processed: Number(job.data?.__meta?.processed || 0),
        success_count: Number(job.data?.__meta?.ok || 0),
        error_count: Number(job.data?.__meta?.err || 0),
        requested_days: Number(job.data?.days || 0),
        error: safeText(error?.message || String(error)),
      });
      throw error;
    }
  });
  queue.on("failed", async (job, err) => {
    console.error("[prazo-producao] job failed:", job?.id, err?.message || err);
    await settleCredits(job?.data?.creditReservation, { release: true });
  });
  queue.on("completed", async (job) => {
    console.log("[prazo-producao] job completed:", job?.id);
    await settleCredits(job?.data?.creditReservation, { release: false });
  });
  console.log("[prazo-producao] worker iniciado");
  return queue;
}

async function enqueuePrazoJob({
  accessToken,
  mlCreds = null,
  mlb_ids,
  days,
  delayMs,
  accountKey = null,
  accountLabel = null,
  auditContext = null,
}) {
  const queue = getQueue();
  const creditReservation = await reserveCredits({
    mlCreds,
    operationKey: "production-time.apply",
    units: Math.max(1, Array.isArray(mlb_ids) ? mlb_ids.length : 0),
  });
  let job;
  try {
    job = await queue.add(
      {
        accessToken,
        mlCreds: mlCreds || null,
        mlb_ids,
        days,
        delayMs,
        accountKey,
        accountLabel,
        auditContext: auditContext && typeof auditContext === "object" ? auditContext : null,
        creditReservation,
      },
      {
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      }
    );
  } catch (error) {
    await settleCredits(creditReservation, { release: true });
    throw error;
  }
  return String(job.id);
}

async function enqueuePrazoLookupActiveJob({
  accessToken,
  mlCreds = null,
  maxItems = null,
  accountKey = null,
  accountLabel = null,
}) {
  const queue = getQueue();
  const creditReservation = await reserveCredits({
    mlCreds,
    operationKey: "production-time.lookup",
    units: Math.max(1, Number(maxItems || 1)),
  });
  let job;
  try {
    job = await queue.add(
      {
        type: "lookup_active",
        accessToken,
        mlCreds: mlCreds || null,
        maxItems,
        accountKey,
        accountLabel,
        creditReservation,
      },
      {
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      }
    );
  } catch (error) {
    await settleCredits(creditReservation, { release: true });
    throw error;
  }
  return String(job.id);
}

async function getPrazoJobStatus(jobId, { accountKey = null } = {}) {
  const queue = getQueue();
  const job = await queue.getJob(resolveJobId(jobId));
  if (!job) return null;
  if (!canAccessJob(job, accountKey)) return null;

  const state = await job.getState(); // completed/failed/active/waiting/delayed
  const progress = Number(job._progress ?? 0);

  const meta = job.data?.__meta || {};
  const total = meta.total ?? job.data?.mlb_ids?.length ?? 0;
  const processed = meta.processed ?? 0;

  const status =
    state === "completed"
      ? meta.status === "cancelado"
        ? "cancelado"
        : "concluido"
      : state === "failed"
      ? "erro"
      : meta.status === "cancelando"
      ? "cancelando"
      : "processando";

  const iniciado_em = meta.startedAt
    ? new Date(meta.startedAt).toISOString()
    : null;
  const concluido_em =
    status === "concluido" && meta.finishedAt
      ? new Date(meta.finishedAt).toISOString()
      : null;

  return {
    id: String(job.id),
    status,
    progresso: Math.max(0, Math.min(100, Math.round(progress))),
    total_anuncios: total,
    processados: processed,
    sucessos: meta.ok ?? 0,
    erros: meta.err ?? 0,
    iniciado_em,
    concluido_em,
  };
}

function buildPrazoAccount(job) {
  const key = job?.data?.accountKey || null;
  const label = job?.data?.accountLabel || key || null;
  return key || label ? { key, label } : null;
}

function resolvePrazoJobTitle(job) {
  if (job?.data?.type === "lookup_active") return "Prazo - consulta ativos";
  return `Prazo - ${Number(job.data?.days ?? 0)} dia(s)`;
}

async function mapPrazoJob(job, { includeRows = false } = {}) {
  if (!job) return null;

  const state = await job.getState().catch(() => "unknown");
  const progress = Number(job._progress ?? 0);
  const meta = job.data?.__meta || {};
  const { total, processed, success, failed, results, resultsCount } =
    resolvePrazoJobMetrics(job, meta);

  let stateLabel = state;
  if (state === "completed") {
    stateLabel =
      meta.status === "cancelado"
        ? "cancelado"
        : `concluido: ${success} ok, ${failed} erros`;
  } else if (state === "failed") {
    stateLabel = meta.error ? `erro: ${meta.error}` : "erro";
  } else if (meta.status === "cancelando") {
    stateLabel = "cancelando";
  } else if (state === "waiting" || state === "delayed") {
    stateLabel = "aguardando";
  } else {
    stateLabel = total > 0 ? `processando ${processed}/${total}` : "processando";
  }

  const returnValue =
    state === "completed"
      ? job.returnvalue || null
      : state === "failed"
        ? { success: false, error: meta.error || job.failedReason || "erro" }
        : null;

  if (includeRows && returnValue && state === "completed") {
    const rows = await readResults(job);
    if (Array.isArray(rows) && rows.length > 0) {
      returnValue.rows = rows;
      if (returnValue.total == null) returnValue.total = rows.length;
    }
  }

  return attachJobContract(attachJobReview({
    id: String(job.id),
    title: resolvePrazoJobTitle(job),
    state: stateLabel,
    status: stateLabel,
    progress: Math.max(0, Math.min(100, Math.round(progress))),
    processed,
    total,
    errors: state === "failed" ? Math.max(1, failed) : failed,
    created_at: new Date(job.timestamp).toISOString(),
    updated_at: new Date(
      meta.finishedAt || meta.updatedAt || job.processedOn || job.timestamp,
    ).toISOString(),
    completed: state === "completed" || state === "failed",
    account: buildPrazoAccount(job),
    result: returnValue,
  }, {
    basePath: "/anuncios/jobs-prazo",
    hasCsv: results.length > 0 || resultsCount > 0,
  }), { module: "prazo", kind: job?.data?.type || "update" });
}

async function listPrazoJobs(limit = 25, { accountKey = null } = {}) {
  const queue = getQueue();
  const jobs = await queue.getJobs(
    ["active", "waiting", "delayed", "failed", "completed"],
    0,
    Math.max(0, Number(limit || 25) - 1),
    false,
  );

  const list = await Promise.all(
    jobs.filter((job) => canAccessJob(job, accountKey)).map(mapPrazoJob),
  );
  return list.filter(Boolean);
}

async function getPrazoJobDetail(jobId, { accountKey = null } = {}) {
  const queue = getQueue();
  const job = await queue.getJob(resolveJobId(jobId));
  if (!job) return null;
  if (!canAccessJob(job, accountKey)) return null;

  return mapPrazoJob(job, { includeRows: true });
}

async function getPrazoJobCsv(jobId, { accountKey = null } = {}) {
  const queue = getQueue();
  const job = await queue.getJob(resolveJobId(jobId));
  if (!job) return null;
  if (!canAccessJob(job, accountKey)) return null;

  const rows = await readResults(job);

  const isLookup = job.data?.type === "lookup_active";
  const csv = isLookup
    ? buildCsv(
        rows.map((row) => [
          row?.mlb_id || "",
          row?.title || "",
          row?.status || "",
          row?.prazo?.has_prazo
            ? row?.prazo?.value_name || `${row?.prazo?.days ?? ""} ${row?.prazo?.unit || "dias"}`.trim()
            : "Sem prazo",
          [row?.shipping_mode, row?.logistic_type].filter(Boolean).join(" / "),
          row?.last_updated || "",
          row?.success ? "" : row?.error || "",
        ]),
        ["mlb_id", "titulo", "status", "prazo_atual", "envio", "atualizado_em", "erro"],
      )
    : buildCsv(
        rows.map((row) => [
          row?.mlb_id || "",
          row?.success ? "success" : "error",
          row?.error || "",
          row?.requested_days ?? "",
          row?.previous_days ?? "",
          row?.applied_days ?? "",
          row?.previous_value ? JSON.stringify(row.previous_value) : "",
          row?.applied_value ? JSON.stringify(row.applied_value) : "",
          row?.ml_status ?? "",
        ]),
        [
          "mlb_id",
          "status",
          "message",
          "prazo_solicitado_dias",
          "prazo_anterior_dias",
          "prazo_aplicado_dias",
          "prazo_anterior_json",
          "prazo_aplicado_json",
          "resposta_ml",
        ],
      );

  return {
    filename: `${isLookup ? "consulta_prazo_ativos" : "prazo_producao"}_${jobId}.csv`,
    csv: `\ufeff${csv}`,
  };
}

async function cancelPrazoJob(jobId, { accountKey = null } = {}) {
  const queue = getQueue();
  const job = await queue.getJob(resolveJobId(jobId));
  if (!job) return null;
  if (!canAccessJob(job, accountKey)) return null;

  const state = await job.getState().catch(() => "unknown");
  if (state === "completed" || state === "failed") {
    return { ok: false, status: state, error: "Job ja finalizado." };
  }

  if (state === "waiting" || state === "delayed") {
    job.data.__meta = {
      ...(job.data.__meta || {}),
      status: "cancelado",
      cancelRequested: false,
      finishedAt: Date.now(),
    };
    await job.update(job.data);
    await settleCredits(job?.data?.creditReservation, { release: true });
    await job.remove();
    return { ok: true, status: "cancelado" };
  }

  job.data.__meta = {
    ...(job.data.__meta || {}),
    status: "cancelando",
    cancelRequested: true,
    updatedAt: Date.now(),
  };
  await job.update(job.data);
  return { ok: true, status: "cancelando" };
}

module.exports = {
  initWorker,
  enqueuePrazoJob,
  enqueuePrazoLookupActiveJob,
  getPrazoJobStatus,
  listPrazoJobs,
  getPrazoJobDetail,
  getPrazoJobCsv,
  cancelPrazoJob,
};
