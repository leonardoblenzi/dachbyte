const Queue = require("bull");
const { makeBullClient, getSharedRedis } = require("../lib/redisClient");

const ValidarDimensoesService = require("./validarDimensoesService");
const AtacadoService = require("./atacadoService");
const { attachJobContract, backendJobIdFromUid } = require("./jobContract");
const { recordAuthEvent } = require("./authAuditService");
const { reserveCredits, settleCredits } = require("./hubCreditsService");

function resolveJobId(value) {
  return backendJobIdFromUid("validar-dimensoes", value);
}

const TTL_SECONDS = Math.max(
  3600,
  Number(process.env.VALIDAR_DIMENSOES_TTL_SECONDS || 6 * 60 * 60),
);
const QUEUE_NAME = "validar-dimensoes";
const RESULT_CHUNK_SIZE = Math.max(
  100,
  Number(process.env.VALIDAR_DIMENSOES_RESULT_CHUNK_SIZE || 500),
);
const ANALYZE_BATCH_SIZE = Math.max(
  1,
  Math.min(20, Number(process.env.VALIDAR_DIMENSOES_ANALYZE_BATCH_SIZE || 20)),
);
const META_UPDATE_EVERY = Math.max(
  1,
  Number(process.env.VALIDAR_DIMENSOES_META_UPDATE_EVERY || 25),
);
const VALIDAR_DIMENSOES_LOCK_DURATION_MS = Math.max(
  60 * 1000,
  Number(process.env.VALIDAR_DIMENSOES_LOCK_DURATION_MS || 30 * 60 * 1000),
);
const VALIDAR_DIMENSOES_STALLED_INTERVAL_MS = Math.max(
  30 * 1000,
  Number(process.env.VALIDAR_DIMENSOES_STALLED_INTERVAL_MS || 2 * 60 * 1000),
);
const VALIDAR_DIMENSOES_MAX_STALLED_COUNT = Math.max(
  1,
  Number(process.env.VALIDAR_DIMENSOES_MAX_STALLED_COUNT || 5),
);
const VALIDAR_DIMENSOES_WORKER_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.VALIDAR_DIMENSOES_WORKER_CONCURRENCY || 4)),
);

let queueInstance = null;
let workerStarted = false;
let redisClient = null;

function normalizeAccountKey(value) {
  const text = String(value || "").trim();
  return text || null;
}

function positiveNumber(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
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
    queueInstance = new Queue(QUEUE_NAME, {
      createClient: (type) => makeBullClient(type, QUEUE_NAME),
      settings: {
        lockDuration: VALIDAR_DIMENSOES_LOCK_DURATION_MS,
        stalledInterval: VALIDAR_DIMENSOES_STALLED_INTERVAL_MS,
        maxStalledCount: VALIDAR_DIMENSOES_MAX_STALLED_COUNT,
      },
    });
  }
  return queueInstance;
}

function getRedis() {
  if (!redisClient) {
    redisClient = getSharedRedis("app");
  }
  return redisClient;
}

function metaKey(jobId) {
  return `ml:validar-dimensoes:${jobId}:meta`;
}

function resultsKey(jobId) {
  return `ml:validar-dimensoes:${jobId}:results`;
}

function resultChunkKey(jobId, index) {
  return `ml:validar-dimensoes:${jobId}:results:${index}`;
}

function sleep(ms) {
  const delay = Number(ms || 0);
  if (!(delay > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delay));
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

async function readMeta(jobId) {
  return readJsonKey(metaKey(jobId));
}

async function updateMeta(job, meta = {}) {
  const current = (await readMeta(job.id)) || {};
  const merged = {
    ...current,
    ...meta,
    updatedAt: Date.now(),
  };
  await writeJsonKey(metaKey(job.id), merged);
  return merged;
}

async function deleteResultChunks(jobId) {
  const current = await readJsonKey(resultsKey(jobId));
  if (!current?.__chunked || !Array.isArray(current.chunks)) return;
  for (const key of current.chunks) {
    if (key) await getRedis().del(key).catch(() => {});
  }
}

async function initResultsManifest(jobId) {
  await deleteResultChunks(jobId);
  await writeJsonKey(resultsKey(jobId), {
    __chunked: true,
    total: 0,
    chunk_size: RESULT_CHUNK_SIZE,
    chunks: [],
  });
}

async function appendResultsChunk(jobId, rows) {
  const safeRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!safeRows.length) return;
  const current =
    (await readJsonKey(resultsKey(jobId))) || {
      __chunked: true,
      total: 0,
      chunk_size: RESULT_CHUNK_SIZE,
      chunks: [],
    };
  const index = Array.isArray(current.chunks) ? current.chunks.length : 0;
  const key = resultChunkKey(jobId, index);
  await writeJsonKey(key, safeRows);
  await writeJsonKey(resultsKey(jobId), {
    __chunked: true,
    total: Number(current.total || 0) + safeRows.length,
    chunk_size: Number(current.chunk_size || RESULT_CHUNK_SIZE),
    chunks: [...(Array.isArray(current.chunks) ? current.chunks : []), key],
  });
}

async function readPersistedTotal(jobId) {
  const payload = await readJsonKey(resultsKey(jobId));
  if (Array.isArray(payload)) return payload.length;
  if (payload?.__chunked && Number.isFinite(Number(payload.total))) {
    return Number(payload.total);
  }
  return 0;
}

async function forEachResultChunk(jobId, callback) {
  if (typeof callback !== "function") return;
  const payload = await readJsonKey(resultsKey(jobId));
  if (Array.isArray(payload)) {
    await callback(payload, 0);
    return;
  }
  if (!payload?.__chunked || !Array.isArray(payload.chunks)) return;
  for (let index = 0; index < payload.chunks.length; index += 1) {
    const key = payload.chunks[index];
    const part = await readJsonKey(key);
    if (Array.isArray(part) && part.length) {
      const result = await callback(part, index);
      if (result === false) break;
    }
  }
}

function gerarCsv(resultados) {
  const header = [
    "MLB",
    "SKU",
    "Origem",
    "Altura_cm",
    "Largura_cm",
    "Comprimento_cm",
    "Peso_g",
    "Status",
    "Mensagem",
    "Atualizou",
    "Alvo_Atualizacao",
    "Dimensoes_Antes_JSON",
    "Dimensoes_Depois_JSON",
    "Payload_JSON",
    "Resposta_ML_JSON",
  ];

  const linhas = resultados.map((r) => {
    const status = r.success ? "OK" : r.status || "ERRO";
    const msg = r.success ? "" : r.message || "";
    const cols = [
      r.mlb || "",
      r.sku || "",
      r.marketplace_origin || "",
      r.height_cm ?? "",
      r.width_cm ?? "",
      r.length_cm ?? "",
      r.weight_g ?? "",
      status,
      msg,
      r.updated === true ? "SIM" : "NAO",
      r.updated_target || "",
      r.debug_update?.before_update ? JSON.stringify(r.debug_update.before_update) : "",
      r.debug_update?.immediate_read ? JSON.stringify(r.debug_update.immediate_read) : "",
      r.debug_update?.update_payload ? JSON.stringify(r.debug_update.update_payload) : "",
      r.debug_update?.update_response ? JSON.stringify(r.debug_update.update_response) : "",
    ];

    return cols
      .map((v) => {
        const s = String(v ?? "");
        return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(";");
  });

  return [header.join(";"), ...linhas].join("\n");
}

function safeText(value, max = 500) {
  const text = value == null ? "" : String(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function auditBase(job = {}) {
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

async function auditDimensoesEvent(job, evento, status, metadata = {}) {
  const base = auditBase(job);
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
      action: "validate_or_update_dimensions",
      ...metadata,
    },
  }).catch((err) => {
    console.error("[validar-dimensoes] audit erro:", err?.message || err);
  });
}

async function processJob(job) {
  const {
    mlbs = [],
    accountKey,
    mlCreds,
    mode = "analyze",
    fillDimensions = null,
    forceOverwrite = false,
    delayMs = 0,
    source = "manual_list",
  } = job.data || {};
  let targetMlbs = Array.isArray(mlbs) ? mlbs.slice() : [];
  let cancelled = false;
  let chunkBuffer = [];

  if (source === "active_items") {
    await updateMeta(job, {
      status: "obtendo anuncios da conta",
      total: 0,
      processed: 0,
      success: 0,
      failed: 0,
      mode,
      source,
      startedAt: Date.now(),
    });

    const state = await AtacadoService.prepareState(mlCreds || {});
    const collected = [];
    let cursor = null;

    for (;;) {
      const latestMeta = (await readMeta(job.id)) || job.data?.__meta || {};
      if (latestMeta.cancelRequested === true) {
        cancelled = true;
        break;
      }

      const page = await AtacadoService.listActiveItemIds(state, {
        cursor,
        limit: 50,
      });
      const pageIds = Array.isArray(page?.ids) ? page.ids : [];
      collected.push(...pageIds);
      cursor = page?.next_cursor || null;
      const listingTotal = Number(page?.total || 0) || collected.length;
      const listingProcessed = collected.length;
      const listingProgress =
        listingTotal > 0 ? Math.max(0, Math.min(100, Math.round((listingProcessed / listingTotal) * 100))) : 0;

      await updateMeta(job, {
        status: "obtendo anuncios da conta",
        total: listingTotal,
        processed: listingProcessed,
        success: 0,
        failed: 0,
        mode,
        source,
        phase: "listing_active_items",
        phase_label: "obtendo anuncios da conta",
      });
      await job.progress(listingProgress);

      if (!cursor || !pageIds.length) break;
    }

    targetMlbs = Array.from(
      new Set(collected.map((value) => String(value || "").trim()).filter(Boolean)),
    );
  }

  const total = Array.isArray(targetMlbs) ? targetMlbs.length : 0;

  if (!total) {
    await initResultsManifest(job.id);
    await updateMeta(job, {
      status: cancelled ? "cancelado" : "concluido",
      total: 0,
      processed: 0,
      success: 0,
      failed: 0,
      mode,
      source,
      cancelRequested: false,
      finishedAt: Date.now(),
    });
    await job.progress(100);
    return {
      success: !cancelled,
      total: 0,
      processed: 0,
      message: cancelled
        ? "Job cancelado antes da consulta."
        : "Nenhum anuncio ativo encontrado para a conta.",
    };
  }

  console.log(
    `[validar-dimensoes] Iniciando job ${job.id} com ${total} MLBs (${accountKey || "sem conta"})`,
  );

  await updateMeta(job, {
    status: "obtendo dados dos anuncios",
    total,
    processed: 0,
    success: 0,
    failed: 0,
    mode,
    source,
    startedAt: Date.now(),
    phase: "fetching_dimensions",
    phase_label: "obtendo dados dos anuncios",
  });
  await job.progress(0);
  await auditDimensoesEvent(job, "dimensions_validation_job_started", "success", {
    total_items: total,
    sample_ids: targetMlbs.slice(0, 20),
    mode,
    source,
    force_overwrite: forceOverwrite === true,
    fill_dimensions: fillDimensions || null,
  });
  let success = 0;
  let failed = 0;
  let processed = 0;
  const effectiveDelayMs = mode === "analyze" ? 0 : Number(delayMs || 0);

  await initResultsManifest(job.id);

  for (let index = 0; index < targetMlbs.length; index += mode === "analyze" ? ANALYZE_BATCH_SIZE : 1) {
    const latestMeta = (await readMeta(job.id)) || job.data?.__meta || {};
    if (latestMeta.cancelRequested === true) {
      cancelled = true;
      break;
    }

    const batch = targetMlbs
      .slice(index, mode === "analyze" ? index + ANALYZE_BATCH_SIZE : index + 1)
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    if (!batch.length) continue;

    if (mode === "analyze") {
      const batchResults = await ValidarDimensoesService.analisarVarios(batch, {
        mlCreds,
        accountKey: accountKey || "conta",
      });
      chunkBuffer.push(...batchResults);
      for (const result of batchResults) {
        if (result?.success) success += 1;
        else failed += 1;
      }
      processed += batch.length;
    } else {
      const mlb = batch[0];
      try {
        const result = await ValidarDimensoesService.analisarUm(mlb, {
          mlCreds,
          accountKey: accountKey || "conta",
          ...(mode === "manual" && fillDimensions ? { fillDimensions } : {}),
          ...(mode === "manual" && forceOverwrite ? { forceOverwrite: true } : {}),
          ...(mode === "auto" ? { autoFillFromItem: true } : {}),
        });
        chunkBuffer.push(result);
        if (result?.success) success += 1;
        else failed += 1;
        await auditDimensoesEvent(
          job,
          "dimensions_validation_item_processed",
          result?.success
            ? result?.updated
              ? "success"
              : "warn"
            : "error",
          {
            mlb_id: result?.mlb || mlb,
            item_id: result?.mlb || mlb,
            sku: result?.sku || "",
            item_index: processed + 1,
            total_items: total,
            mode,
            source,
            updated: result?.updated === true,
            updated_target: result?.updated_target || null,
            previous_value: result?.debug_update?.before_update || null,
            requested_value: result?.debug_update?.requested_fill || fillDimensions || null,
            applied_value: result?.debug_update?.immediate_read || null,
            update_payload: result?.debug_update?.update_payload || null,
            ml_body: result?.debug_update?.update_response || null,
            message: safeText(result?.updated_message || result?.message || ""),
          },
        );
      } catch (err) {
        const errorRow = {
          mlb,
          success: false,
          status: "ERRO",
          message: err?.message || String(err),
          raw: null,
          height_cm: null,
          width_cm: null,
          length_cm: null,
          weight_g: null,
        };
        chunkBuffer.push(errorRow);
        failed += 1;
        await auditDimensoesEvent(job, "dimensions_validation_item_processed", "error", {
          mlb_id: mlb,
          item_id: mlb,
          item_index: processed + 1,
          total_items: total,
          mode,
          source,
          updated: false,
          error: safeText(errorRow.message),
          message: safeText(errorRow.message),
        });
      }
      processed += 1;
    }
    if (chunkBuffer.length >= RESULT_CHUNK_SIZE) {
      await appendResultsChunk(job.id, chunkBuffer);
      chunkBuffer = [];
    }
    const pct = total > 0 ? Math.round((processed / total) * 100) : 100;
    const shouldRefreshMeta =
      processed === total || processed === 1 || processed % META_UPDATE_EVERY === 0;
    if (shouldRefreshMeta) {
      await updateMeta(job, {
        status: "obtendo dados dos anuncios",
        total,
        processed,
        success,
        failed,
        mode,
        source,
        phase: "fetching_dimensions",
        phase_label: "obtendo dados dos anuncios",
      });
      await job.progress(pct);
    }
    if (index < targetMlbs.length - 1 && effectiveDelayMs > 0) {
      await sleep(effectiveDelayMs);
    }
  }

  if (chunkBuffer.length) {
    await appendResultsChunk(job.id, chunkBuffer);
    chunkBuffer = [];
  }

  const result = {
    success: !cancelled,
    cancelled,
    total,
    processed,
    success_count: success,
    failed_count: failed,
    fileName: `dimensoes-mlb-${job.id}.csv`,
    createdAt: new Date().toISOString(),
  };

  await updateMeta(job, {
    status: cancelled ? "cancelado" : "concluido",
    total,
    processed,
    success,
    failed,
    mode,
    source,
    cancelRequested: false,
    finishedAt: Date.now(),
  });
  await job.progress(100);
  await auditDimensoesEvent(job, "dimensions_validation_job_completed", failed > 0 ? "warn" : "success", {
    total_items: total,
    processed,
    success_count: success,
    failed_count: failed,
    mode,
    source,
    cancelled,
  });

  if (cancelled) {
    console.log(`[validar-dimensoes] Job ${job.id} cancelado com ${processed}/${total}`);
  } else {
    console.log(`[validar-dimensoes] Job ${job.id} concluido com ${processed}/${total}`);
  }

  return result;
}

function iniciarWorker() {
  if (workerStarted) return;
  workerStarted = true;

  const queue = getQueue();
  queue.process(VALIDAR_DIMENSOES_WORKER_CONCURRENCY, async (job) => {
    try {
      return await processJob(job);
    } catch (err) {
      await updateMeta(job, {
        status: "erro",
        finishedAt: Date.now(),
      }).catch(() => null);
      await auditDimensoesEvent(job, "dimensions_validation_job_failed", "error", {
        mode: job?.data?.mode || null,
        source: job?.data?.source || null,
        error: safeText(err?.message || String(err)),
      });
      console.error("[validar-dimensoes] erro no worker:", err);
      throw err;
    }
  });

  queue.on("failed", async (job, err) => {
    console.error(`[validar-dimensoes] Job ${job.id} falhou:`, err?.message || err);
    await settleCredits(job?.data?.creditReservation, { release: true });
  });

  queue.on("completed", async (job) => {
    console.log(`[validar-dimensoes] Job ${job.id} finalizado`);
    await settleCredits(job?.data?.creditReservation, { release: false });
  });

  console.log(
    `Worker de validar-dimensoes iniciado - concurrency=${VALIDAR_DIMENSOES_WORKER_CONCURRENCY}`,
  );
}

async function criarJob(
  mlbs = [],
  {
    accountKey,
    mlCreds,
    mode = "analyze",
    fillDimensions = null,
    forceOverwrite = false,
    delayMs = 0,
    source = "manual_list",
    auditContext = null,
  } = {},
) {
  const queue = getQueue();
  const creditReservation = await reserveCredits({
    mlCreds,
    operationKey: "dimensions.validate",
    units: Math.max(1, Array.isArray(mlbs) ? mlbs.length : 0),
  });
  await cancelarJobsAbertosDaConta(accountKey, { reason: "novo_job" });
  let job;
  try {
    job = await queue.add(
      {
        mlbs,
        accountKey: accountKey || "conta",
        mlCreds: mlCreds || {},
        mode,
        fillDimensions,
        forceOverwrite: forceOverwrite === true,
        delayMs: Math.max(0, Number(delayMs || 0) || 0),
        source: source === "active_items" ? "active_items" : "manual_list",
        auditContext: auditContext && typeof auditContext === "object" ? auditContext : null,
        creditReservation,
      },
      {
        attempts: 1,
        removeOnComplete: 50,
        removeOnFail: 50,
      },
    );
  } catch (error) {
    await settleCredits(creditReservation, { release: true });
    throw error;
  }

  await updateMeta(job, {
    status: "aguardando",
    total: Array.isArray(mlbs) ? mlbs.length : 0,
    processed: 0,
    success: 0,
    failed: 0,
    mode,
    source: source === "active_items" ? "active_items" : "manual_list",
  });

  return attachJobContract({
    success: true,
    jobId: job.id,
  }, { module: "validar-dimensoes", kind: job.data?.source || "manual_list" });
}

function mapJob(j, status, meta = null) {
  const currentMeta = meta || j.data?.__meta || {};
  const result = j.returnvalue || {};
  const total = Math.max(
    positiveNumber(currentMeta.total),
    positiveNumber(result.total),
    Array.isArray(j.data?.mlbs) ? j.data.mlbs.length : 0,
  );
  const processed = Math.max(
    positiveNumber(currentMeta.processed),
    positiveNumber(result.processed),
  );
  const success = Math.max(
    positiveNumber(currentMeta.success),
    positiveNumber(result.success_count),
  );
  const failed = Math.max(
    positiveNumber(currentMeta.failed),
    positiveNumber(result.failed_count),
  );
  const progress = total > 0 ? Math.round((processed / total) * 100) : Number(j._progress || 0);

  let stateLabel = currentMeta.status || status;
  if (status === "waiting" || status === "delayed") stateLabel = "aguardando";
  if (status === "active" && stateLabel !== "cancelando") {
    stateLabel = currentMeta.status || (total > 0 ? `processando ${processed}/${total}` : "processando");
  }
  if (status === "failed") stateLabel = "erro";
  if (status === "completed" && currentMeta.status === "cancelado") stateLabel = "cancelado";
  if (status === "completed" && currentMeta.status !== "cancelado") stateLabel = "concluido";

  return {
    id: String(j.id),
    title:
      j.data?.source === "active_items"
        ? `Validar dimensoes - ativos da conta (${total})`
        : `Validar dimensoes - ${total} item(ns)`,
    state: stateLabel,
    status: stateLabel,
    progress,
    processed,
    total,
    success,
    errors: failed,
    completed: ["concluido", "cancelado", "erro"].includes(stateLabel),
    account: j.data?.accountKey ? { key: j.data.accountKey, label: j.data.accountKey } : null,
    data: {
      total_mlbs: total,
      accountKey: j.data?.accountKey || null,
      mode: j.data?.mode || "analyze",
      source: j.data?.source || "manual_list",
    },
    timestamp: j.timestamp,
    finishedOn: currentMeta.finishedAt || j.finishedOn || null,
    failedReason: j.failedReason || null,
  };
}

async function listarJobs(limit = 50, { accountKey = null } = {}) {
  const queue = getQueue();
  const safeLimit = Math.max(1, Math.min(100, Number(limit || 50) || 50));
  const scanLimit = Math.max(safeLimit, 200);
  const [waiting, active, delayed, completed, failed] = await Promise.all([
    queue.getJobs(["waiting"], 0, scanLimit),
    queue.getJobs(["active"], 0, scanLimit),
    queue.getJobs(["delayed"], 0, scanLimit),
    queue.getJobs(["completed"], 0, scanLimit),
    queue.getJobs(["failed"], 0, scanLimit),
  ]);

  const items = [];
  for (const job of [...waiting, ...active, ...delayed, ...completed, ...failed]) {
    const meta = await readMeta(job.id);
    const state = await job.getState().catch(() => "unknown");
    const mapped = mapJob(job, state, meta);
    if (canAccessJob(job, accountKey)) {
      items.push(mapped);
    }
  }
  return items.slice(0, safeLimit);
}

async function obterStatus(jobId, { accountKey = null } = {}) {
  const queue = getQueue();
  const job = await queue.getJob(resolveJobId(jobId));
  if (!job) return null;
  if (!canAccessJob(job, accountKey)) return null;

  const state = await job.getState();
  const meta = await readMeta(job.id);
  const mapped = mapJob(job, state, meta);
  const persistedResultTotal = await readPersistedTotal(jobId);

  return {
    ...mapped,
    result_total: persistedResultTotal,
    has_results: persistedResultTotal > 0,
    result: job.returnvalue || null,
  };
}

async function obterResultados(jobId, { accountKey = null } = {}) {
  const queue = getQueue();
  const job = await queue.getJob(resolveJobId(jobId));
  if (!job) return null;
  if (!canAccessJob(job, accountKey)) return null;

  const state = await job.getState();
  if (state !== "completed" && state !== "failed") return null;

  const rows = [];
  await forEachResultChunk(jobId, async (chunk) => {
    rows.push(...chunk);
  });
  return rows;
}

async function obterPaginaResultados(
  jobId,
  { accountKey = null, offset = 0, limit = 50 } = {},
) {
  const queue = getQueue();
  const job = await queue.getJob(resolveJobId(jobId));
  if (!job) return null;
  if (!canAccessJob(job, accountKey)) return null;

  const state = await job.getState();
  if (state !== "completed" && state !== "failed") return null;

  const safeOffset = Math.max(0, Number(offset || 0));
  const safeLimit = Math.max(1, Number(limit || 50));
  const manifest = await readJsonKey(resultsKey(jobId));
  const total = Math.max(
    0,
    Array.isArray(manifest)
      ? manifest.length
      : Number(manifest?.total || (await readPersistedTotal(jobId)) || 0),
  );
  const pageRows = [];
  let seen = 0;

  await forEachResultChunk(jobId, async (chunk) => {
    const nextSeen = seen + chunk.length;
    if (nextSeen <= safeOffset) {
      seen = nextSeen;
      return true;
    }

    const startIndex = Math.max(0, safeOffset - seen);
    const remaining = safeLimit - pageRows.length;
    if (remaining > 0) {
      pageRows.push(...chunk.slice(startIndex, startIndex + remaining));
    }
    seen = nextSeen;

    if (pageRows.length >= safeLimit) {
      return false;
    }
    return true;
  });

  return { rows: pageRows, total };
}

async function obterCsv(jobId, { accountKey = null } = {}) {
  const queue = getQueue();
  const job = await queue.getJob(resolveJobId(jobId));
  if (!job) return null;
  if (!canAccessJob(job, accountKey)) return null;

  const state = await job.getState();
  if (state !== "completed" && state !== "failed") return null;

  const rows = [];
  await forEachResultChunk(jobId, async (chunk) => {
    rows.push(...chunk);
  });
  return {
    filename: `dimensoes-mlb-${jobId}.csv`,
    csv: gerarCsv(rows),
  };
}

async function cancelarJob(jobId, { accountKey = null } = {}) {
  const queue = getQueue();
  const job = await queue.getJob(resolveJobId(jobId));
  if (!job) return null;
  if (!canAccessJob(job, accountKey)) return null;

  const state = await job.getState().catch(() => "unknown");
  if (state === "completed" || state === "failed") {
    return { ok: false, status: state, error: "Job ja finalizado." };
  }

  if (state === "waiting" || state === "delayed") {
    await updateMeta(job, {
      status: "cancelado",
      cancelRequested: false,
      finishedAt: Date.now(),
    });
    await job.remove();
    return { ok: true, status: "cancelado" };
  }

  await updateMeta(job, {
    status: "cancelando",
    cancelRequested: true,
  });
  return { ok: true, status: "cancelando" };
}

async function cancelarJobsAbertosDaConta(accountKey, { reason = "novo_job" } = {}) {
  const normalizedAccountKey = normalizeAccountKey(accountKey);
  if (!normalizedAccountKey) return 0;

  const queue = getQueue();
  const states = ["waiting", "delayed", "active"];
  const jobs = await queue.getJobs(states, 0, 200);
  let cancelled = 0;

  for (const job of jobs) {
    if (!canAccessJob(job, normalizedAccountKey)) continue;
    const state = await job.getState().catch(() => "unknown");
    if (state === "completed" || state === "failed") continue;

    await updateMeta(job, {
      status: state === "active" ? "cancelando" : "cancelado",
      cancelRequested: state === "active",
      cancelReason: reason,
      ...(state === "active" ? {} : { finishedAt: Date.now() }),
    }).catch(() => null);

    if (state === "waiting" || state === "delayed") {
      await job.remove().catch(() => null);
    }
    cancelled += 1;
  }

  return cancelled;
}

module.exports = {
  iniciarWorker,
  criarJob,
  listarJobs,
  obterStatus,
  obterResultados,
  obterPaginaResultados,
  obterCsv,
  cancelarJob,
  cancelarJobsAbertosDaConta,
};
