"use strict";

const Bull = require("bull");
const { makeBullClient, getSharedRedis } = require("../lib/redisClient");
const ExclusaoService = require("./excluirAnuncioService");
const { attachJobReview } = require("./jobReviewHelper");
const { attachJobContract, backendJobIdFromUid } = require("./jobContract");

function resolveJobId(value) {
  return backendJobIdFromUid("gestao-anuncios", value);
}
const { recordAuthEvent } = require("./authAuditService");
const { reserveCredits, settleCredits } = require("./hubCreditsService");

const QUEUE_NAME = "ml-exclusao-lote";
const SERVICE_LOG_LABEL = "GestaoAnunciosJobService";

let queueInstance = null;
let workerStarted = false;
let redisClient = null;

const RESULT_TTL_SECONDS = Math.max(
  3600,
  Number(process.env.EXCLUSAO_LOTE_RESULT_TTL_SECONDS || 3 * 24 * 60 * 60),
);
const RESULT_CHUNK_SIZE = Math.max(
  100,
  Number(process.env.EXCLUSAO_LOTE_RESULT_CHUNK_SIZE || 500),
);
const META_UPDATE_EVERY = Math.max(
  1,
  Number(process.env.EXCLUSAO_LOTE_META_UPDATE_EVERY || 25),
);
const WORKER_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.EXCLUSAO_LOTE_WORKER_CONCURRENCY || 4)),
);

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

function getRedis() {
  if (!redisClient) redisClient = getSharedRedis("app");
  return redisClient;
}

function resultsManifestKey(jobId) {
  return `ml:gestao-anuncios:${jobId}:results`;
}

function jobMetaKey(jobId) {
  return `ml:gestao-anuncios:${jobId}:meta`;
}

function resultChunkKey(jobId, index) {
  return `ml:gestao-anuncios:${jobId}:results:${index}`;
}

async function readJsonKey(key) {
  try {
    const raw = await getRedis().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function writeJsonKey(key, value) {
  await getRedis().set(key, JSON.stringify(value), "EX", RESULT_TTL_SECONDS);
}

async function deleteResultChunks(jobId) {
  const manifest = await readJsonKey(resultsManifestKey(jobId));
  if (!manifest?.__chunked || !Array.isArray(manifest.chunks)) return;
  await Promise.all(
    manifest.chunks
      .filter(Boolean)
      .map((key) => getRedis().del(key).catch(() => 0)),
  );
}

async function initResultsManifest(jobId) {
  await deleteResultChunks(jobId);
  await writeJsonKey(resultsManifestKey(jobId), {
    __chunked: true,
    total: 0,
    chunk_size: RESULT_CHUNK_SIZE,
    chunks: [],
  });
}

async function appendResultsChunk(jobId, rows) {
  const safeRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!safeRows.length) return;
  const manifest =
    (await readJsonKey(resultsManifestKey(jobId))) || {
      __chunked: true,
      total: 0,
      chunk_size: RESULT_CHUNK_SIZE,
      chunks: [],
    };
  const chunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
  const key = resultChunkKey(jobId, chunks.length);
  await writeJsonKey(key, safeRows);
  await writeJsonKey(resultsManifestKey(jobId), {
    __chunked: true,
    total: Number(manifest.total || 0) + safeRows.length,
    chunk_size: Number(manifest.chunk_size || RESULT_CHUNK_SIZE),
    chunks: [...chunks, key],
  });
}

async function forEachResultChunk(jobId, callback) {
  if (typeof callback !== "function") return;
  const manifest = await readJsonKey(resultsManifestKey(jobId));
  if (Array.isArray(manifest)) {
    await callback(manifest, 0);
    return;
  }
  if (!manifest?.__chunked || !Array.isArray(manifest.chunks)) return;
  for (let index = 0; index < manifest.chunks.length; index += 1) {
    const rows = await readJsonKey(manifest.chunks[index]);
    if (Array.isArray(rows) && rows.length) await callback(rows, index);
  }
}

async function readPersistedResultTotal(jobId) {
  const manifest = await readJsonKey(resultsManifestKey(jobId));
  if (Array.isArray(manifest)) return manifest.length;
  return Math.max(0, Number(manifest?.total || 0));
}

async function readJobMeta(jobId) {
  return readJsonKey(jobMetaKey(jobId));
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
  return v || null;
}

function parseMlDetails(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

const OPERATIONS = {
  ACTIVATE: {
    label: "Ativacao",
    rowSuccess: "Anuncio ativado com sucesso",
    rowFailure: "Falha ao ativar anuncio",
    targetStatus: "active",
  },
  PAUSE: {
    label: "Pausa",
    rowSuccess: "Anuncio pausado com sucesso",
    rowFailure: "Falha ao pausar anuncio",
    targetStatus: "paused",
  },
  CLOSE: {
    label: "Encerramento",
    rowSuccess: "Anuncio encerrado com sucesso",
    rowFailure: "Falha ao encerrar anuncio",
    targetStatus: "closed",
  },
  DELETE: {
    label: "Exclusao",
    rowSuccess: "Anuncio excluido com sucesso",
    rowFailure: "Falha ao excluir anuncio",
    targetStatus: null,
  },
  CLOSE_RELIST: {
    label: "Relistagem",
    rowSuccess: "Anuncio relistado com sucesso",
    rowFailure: "Falha ao relistar anuncio",
    targetStatus: null,
  },
  PAUSE_RELIST: {
    label: "Pausar e relistar",
    rowSuccess: "Anuncio pausado e relistado com sucesso",
    rowFailure: "Falha ao pausar e relistar anuncio",
    targetStatus: null,
  },
};

function normalizeOperation(value) {
  const op = String(value || "DELETE").trim().toUpperCase();
  return OPERATIONS[op] ? op : "DELETE";
}

function safeText(value, max = 500) {
  const text = value == null ? "" : String(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function buildAuditBase(job, operation) {
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
    operation,
    job_id: job?.id ? String(job.id) : null,
  };
}

async function auditJobEvent(job, evento, status, operation, metadata = {}) {
  const base = buildAuditBase(job, operation);
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
      operation: base.operation,
      job_id: base.job_id,
      ...metadata,
    },
  }).catch((err) => {
    console.error("[ExclusaoLoteJobService] audit erro:", err?.message || err);
  });
}

function describeOperationFailure(result = {}, operationConfig = OPERATIONS.DELETE) {
  const details = parseMlDetails(result?.detalhes_ml);
  const causeCode = details?.cause?.[0]?.code || null;
  const status = String(result?.status_inicial || "").toLowerCase();

  if (
    result?.non_modifiable_status ||
    causeCode === "item.status.not_modifiable" ||
    ["under_review", "inactive", "not_yet_active"].includes(status)
  ) {
    return {
      reason: "Anuncio bloqueado por revisao ou moderacao do Mercado Livre.",
      solution:
        "Revisar/corrigir o anuncio no painel do Mercado Livre e aguardar ele sair desse estado antes de tentar excluir novamente.",
    };
  }

  if (/nao pertence/i.test(String(result?.message || ""))) {
    return {
      reason: "O anuncio pertence a outra conta do Mercado Livre.",
      solution: "Trocar para a conta correta e executar a exclusao novamente.",
    };
  }

  if (/nao encontrado|invalido/i.test(String(result?.message || ""))) {
    return {
      reason: "O MLB informado nao foi encontrado ou nao esta acessivel para a conta atual.",
      solution: "Conferir o MLB e a conta ativa antes de reenviar a exclusao.",
    };
  }

  return {
    reason: `O Mercado Livre recusou a operacao de ${String(operationConfig.label || "gestao").toLowerCase()}.`,
    solution: "Revisar a mensagem detalhada e o estado do anuncio antes de tentar novamente.",
  };
}

function canAccessJob(job, accountKey) {
  const wanted = normalizeAccountKey(accountKey);
  const current = normalizeAccountKey(job?.data?.accountKey);
  if (!wanted) return false;
  if (!current) return false;
  if (current === "default") return false;
  return current === wanted;
}

async function updateMeta(job, meta) {
  const current = (await readJobMeta(job.id)) || job.data?.__meta || {};
  const merged = {
    ...current,
    ...meta,
  };
  job.data.__meta = merged;
  await writeJsonKey(jobMetaKey(job.id), merged);
  return merged;
}

function resolveResultSku(result = {}) {
  const direct = String(result?.sku || result?.seller_sku || "").trim();
  if (direct) return direct;
  const loadedStep = Array.isArray(result?.steps)
    ? result.steps.find((step) => step?.step === "item_carregado" && step?.sku)
    : null;
  return String(loadedStep?.sku || "").trim();
}

function resolveFinalStatus(result = {}, operation = "DELETE") {
  if (operation === "DELETE" && result?.success && result?.deletado === true) {
    return "deleted";
  }
  return String(
    result?.status_final ||
      result?.status_pos_fechamento ||
      result?.status_inicial ||
      "",
  ).trim();
}

async function runJob(job) {
  const mlbIds = Array.isArray(job.data?.mlbIds)
    ? job.data.mlbIds.map((id) => String(id || "").trim().toUpperCase()).filter(Boolean)
    : [];
  const delayMs = Math.max(0, Number(job.data?.delayMs || 0));
  const operation = normalizeOperation(job.data?.operation);
  const operationConfig = OPERATIONS[operation];
  const total = mlbIds.length;

  await updateMeta(job, {
    status: "processando",
    operation,
    total,
    processed: 0,
    success: 0,
    failed: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  });
  await job.progress(0);

  await auditJobEvent(job, "listing_management_job_processing_started", "success", operation, {
    total_items: total,
    delay_ms: delayMs,
    sample_ids: mlbIds.slice(0, 20),
  });

  const state = await ExclusaoService.prepararState({
    mlCreds: job.data?.mlCreds || {},
    accountKey: job.data?.accountKey || null,
  });

  const failedItems = [];
  let resultBuffer = [];
  let success = 0;
  let failed = 0;

  await initResultsManifest(job.id);

  for (let index = 0; index < mlbIds.length; index++) {
    if (index % META_UPDATE_EVERY === 0) {
      job.data.__meta = (await readJobMeta(job.id)) || job.data?.__meta || {};
    }
    if (job.data.__meta?.cancelRequested) {
      if (resultBuffer.length) await appendResultsChunk(job.id, resultBuffer);
      throw new JobCancelledError();
    }
    const mlbId = mlbIds[index];
    const result =
      operation === "DELETE"
        ? await ExclusaoService.excluirUnico(mlbId, state)
        : operation === "CLOSE_RELIST" || operation === "PAUSE_RELIST"
          ? await ExclusaoService.relistar(mlbId, operation, state)
        : await ExclusaoService.atualizarStatus(
            mlbId,
            operationConfig.targetStatus,
            state,
          );
    const friendly = result?.success
      ? { reason: "", solution: "" }
      : describeOperationFailure(result, operationConfig);
    const row = {
      mlb_id: mlbId,
      sku: resolveResultSku(result),
      operation,
      status_anterior: result?.status_inicial || "",
      status_final: resolveFinalStatus(result, operation),
      status: result?.success ? "success" : "error",
      success: !!result?.success,
      message:
        result?.message ||
        result?.error ||
        (result?.success ? operationConfig.rowSuccess : operationConfig.rowFailure),
      reason: friendly.reason || "",
      solution: friendly.solution || "",
    };
    resultBuffer.push(row);

    await auditJobEvent(
      job,
      "listing_management_item_processed",
      result?.success ? "success" : "warn",
      operation,
      {
        mlb_id: mlbId,
        item_index: index + 1,
        total_items: total,
        success: !!result?.success,
        status: row.status,
        message: safeText(row.message),
        reason: safeText(row.reason),
        solution: safeText(row.solution),
        status_inicial: result?.status_inicial || null,
        status_final: result?.status_final || result?.status_pos_fechamento || null,
        changed: typeof result?.changed === "boolean" ? result.changed : null,
        relisted_id: result?.relisted_id || result?.mlb_new || null,
        fallback_closed: typeof result?.fallback_closed === "boolean" ? result.fallback_closed : null,
      },
    );

    if (result?.success) {
      success += 1;
    } else {
      failed += 1;
      if (failedItems.length < 200) {
        failedItems.push({
          mlb_id: mlbId,
          message: result?.message || operationConfig.rowFailure,
        });
      }
    }

    const processed = index + 1;
    const progress = total > 0 ? clampProgress((processed / total) * 100) : 100;

    if (resultBuffer.length >= RESULT_CHUNK_SIZE) {
      await appendResultsChunk(job.id, resultBuffer);
      resultBuffer = [];
    }

    if (processed === 1 || processed === total || processed % META_UPDATE_EVERY === 0) {
      await updateMeta(job, {
        status: "processando",
        operation,
        total,
        processed,
        success,
        failed,
        failedItems,
        updatedAt: Date.now(),
      });
      await job.progress(progress);
    }

    if (delayMs > 0 && processed < total) {
      await sleep(delayMs);
    }
  }

  if (resultBuffer.length) {
    await appendResultsChunk(job.id, resultBuffer);
    resultBuffer = [];
  }

  await updateMeta(job, {
    status: "concluido",
    operation,
    total,
    processed: total,
    success,
    failed,
    failedItems,
    finishedAt: Date.now(),
    updatedAt: Date.now(),
  });
  await job.progress(100);

  await auditJobEvent(job, "listing_management_job_completed", failed > 0 ? "warn" : "success", operation, {
    total_items: total,
    processed: total,
    success,
    failed,
    failed_items: failedItems.slice(0, 50),
  });

  return {
    ok: true,
    operation,
    total,
    success,
    failed,
    failedItems,
    result_total: total,
  };
}

async function mapJob(job) {
  if (!job) return null;

  const state = await job.getState().catch(() => "unknown");
  const meta = (await readJobMeta(job.id)) || job.data?.__meta || {};
  const operation = normalizeOperation(meta.operation || job.data?.operation);
  const operationConfig = OPERATIONS[operation];
  const { total, processed, success, failed, failedItems } =
    resolveJobMetrics(job, meta);
  const persistedResultTotal = await readPersistedResultTotal(job.id);
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

  return attachJobContract(attachJobReview({
    id: String(job.id),
    title: `${operationConfig.label} - ${total} item(ns)`,
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
    result_total: persistedResultTotal,
    operation,
    account: buildAccount(job.data),
    result: status === "concluido" ? job.returnvalue || null : null,
    failed_items: failedItems,
  }, {
    basePath: "/api/excluir-anuncio/jobs",
    hasCsv: persistedResultTotal > 0 || failedItems.length > 0,
  }), { module: "gestao-anuncios", kind: operation });
}

function getJobResults(job) {
  const meta = job?.data?.__meta || {};
  if (Array.isArray(meta.results)) return meta.results;
  if (Array.isArray(job?.returnvalue?.results)) return job.returnvalue.results;
  return [];
}

async function getJobCsv(jobId, { accountKey = null } = {}) {
  const queue = getQueue();
  const job = await queue.getJob(resolveJobId(jobId));
  if (!job) return null;
  if (!canAccessJob(job, accountKey)) return null;

  return {
    filename: `gestao_anuncios_${jobId}.csv`,
  };
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function resultRowToCsv(row) {
  return [
    row?.mlb_id || "",
    row?.sku || "",
    row?.operation || "",
    row?.status_anterior || row?.initial_status || "",
    row?.status_final || row?.final_status || "",
    row?.status || (row?.success ? "success" : "error"),
    row?.message || "",
  ].map(csvCell).join(";");
}

async function streamJobCsv(jobId, res) {
  res.write(
    "\ufeffMLB;SKU;operacao;status_anterior;status_final;resultado;mensagem\n",
  );
  let streamedRows = 0;
  await forEachResultChunk(jobId, async (rows) => {
    if (!rows.length) return;
    res.write(`${rows.map(resultRowToCsv).join("\n")}\n`);
    streamedRows += rows.length;
  });

  if (!streamedRows) {
    const job = await getQueue().getJob(resolveJobId(jobId));
    const legacyRows = getJobResults(job);
    if (legacyRows.length) {
      res.write(`${legacyRows.map(resultRowToCsv).join("\n")}\n`);
    }
  }
}

async function enqueueJob({
  mlbIds,
  delayMs = 250,
  operation = "DELETE",
  mlCreds = {},
  accountKey = null,
  accountLabel = null,
  auditContext = null,
}) {
  const queue = getQueue();
  const creditReservation = await reserveCredits({
    mlCreds,
    operationKey: "listing.bulk-delete",
    units: Math.max(1, Array.isArray(mlbIds) ? mlbIds.length : 0),
  });
  let job;
  try {
    job = await queue.add(
      {
        mlbIds,
        delayMs,
        operation: normalizeOperation(operation),
        mlCreds,
        accountKey,
        accountLabel,
        auditContext,
        creditReservation,
        createdAt: Date.now(),
      },
      {
        attempts: 1,
        removeOnComplete: 30,
        removeOnFail: false,
      },
    );
  } catch (error) {
    await settleCredits(creditReservation, { release: true });
    throw error;
  }

  return String(job.id);
}

async function getJobDetail(jobId, { accountKey = null } = {}) {
  const queue = getQueue();
  const job = await queue.getJob(resolveJobId(jobId));
  if (!job) return null;
  if (!canAccessJob(job, accountKey)) return null;
  return mapJob(job);
}

async function getJobStatus(jobId, { accountKey = null } = {}) {
  const detail = await getJobDetail(jobId, { accountKey });
  if (!detail) return null;
  return {
    id: detail.id,
    status: detail.status,
    progresso: detail.progresso,
    total_anuncios: detail.total_anuncios,
    processados: detail.processados,
    sucessos: detail.sucessos,
    erros: detail.erros,
    iniciado_em: detail.iniciado_em,
    concluido_em: detail.concluido_em,
    account: detail.account,
  };
}

async function cancelJob(jobId, { accountKey = null, auditContext = null } = {}) {
  const queue = getQueue();
  const job = await queue.getJob(resolveJobId(jobId));
  if (!job) return null;
  if (!canAccessJob(job, accountKey)) return null;
  if (auditContext && typeof auditContext === "object") {
    job.data.auditContext = {
      ...(job.data.auditContext || {}),
      ...auditContext,
    };
    await job.update(job.data);
  }

  const state = await job.getState().catch(() => "unknown");
  const meta = (await readJobMeta(job.id)) || job.data?.__meta || {};
  if (state === "completed" || state === "failed") {
    await auditJobEvent(
      job,
      "listing_management_job_cancel_rejected",
      "warn",
      normalizeOperation(meta.operation || job.data?.operation),
      {
        requested_status: state,
        reason: "Job ja finalizado.",
      },
    );
    return { ok: false, status: state, error: "Job ja finalizado." };
  }

  if (state === "waiting" || state === "delayed") {
    await auditJobEvent(
      job,
      "listing_management_job_canceled",
      "success",
      normalizeOperation(meta.operation || job.data?.operation),
      {
        previous_status: state,
        canceled_before_processing: true,
      },
    );
    await updateMeta(job, {
      status: "cancelado",
      finishedAt: Date.now(),
      updatedAt: Date.now(),
      cancelRequested: false,
    });
    await settleCredits(job?.data?.creditReservation, { release: true });
    await job.remove();
    return { ok: true, status: "cancelado" };
  }

  await updateMeta(job, {
    status: "cancelando",
    cancelRequested: true,
    updatedAt: Date.now(),
  });
  await auditJobEvent(
    job,
    "listing_management_job_cancel_requested",
    "success",
    normalizeOperation(meta.operation || job.data?.operation),
    {
      previous_status: state,
    },
  );
  return { ok: true, status: "cancelando" };
}

async function listJobs(limit = 25, { accountKey = null } = {}) {
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

function initWorker() {
  const queue = getQueue();
  if (workerStarted) return queue;

  workerStarted = true;
  queue.process(WORKER_CONCURRENCY, async (job) => {
    try {
      return await runJob(job);
    } catch (error) {
      const meta = (await readJobMeta(job.id)) || job.data?.__meta || {};
      if (error instanceof JobCancelledError) {
        await auditJobEvent(
          job,
          "listing_management_job_canceled",
          "warn",
          normalizeOperation(meta.operation || job.data?.operation),
          {
            processed: Number(meta.processed ?? 0),
            total_items: Number(meta.total ?? job.data?.mlbIds?.length ?? 0),
            success: Number(meta.success ?? 0),
            failed: Number(meta.failed ?? 0),
          },
        );
        await updateMeta(job, {
          status: "cancelado",
          finishedAt: Date.now(),
          updatedAt: Date.now(),
          cancelRequested: false,
        });
        await job.progress(100);
        return {
          ok: false,
          cancelled: true,
          total: Number(meta.total ?? job.data?.mlbIds?.length ?? 0),
          success: Number(meta.success ?? 0),
          failed: Number(meta.failed ?? 0),
          failedItems: Array.isArray(meta.failedItems) ? meta.failedItems : [],
          result_total: await readPersistedResultTotal(job.id),
        };
      }
      await auditJobEvent(
        job,
        "listing_management_job_failed",
        "error",
        normalizeOperation(meta.operation || job.data?.operation),
        {
          error: safeText(error?.message || String(error)),
          processed: Number(meta.processed ?? 0),
          total_items: Number(meta.total ?? job.data?.mlbIds?.length ?? 0),
          success: Number(meta.success ?? 0),
          failed: Number(meta.failed ?? 0),
        },
      );
      throw error;
    }
  });
  queue.on("failed", async (job, err) => {
    console.error(`[${SERVICE_LOG_LABEL}] job failed:`, job?.id, err?.message || err);
    await settleCredits(job?.data?.creditReservation, { release: true });
  });
  queue.on("completed", async (job) => {
    console.log(`[${SERVICE_LOG_LABEL}] job completed:`, job?.id);
    await settleCredits(job?.data?.creditReservation, { release: false });
  });

  console.log(
    `[${SERVICE_LOG_LABEL}] worker iniciado (concurrency=${WORKER_CONCURRENCY})`,
  );
  return queue;
}

module.exports = {
  initWorker,
  enqueueJob,
  getJobStatus,
  getJobDetail,
  listJobs,
  cancelJob,
  getJobCsv,
  streamJobCsv,
};
