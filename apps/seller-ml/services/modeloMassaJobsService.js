"use strict";

const Bull = require("bull");
const crypto = require("crypto");
const ModeloMassaService = require("./modeloMassaService");
const { makeBullClient, getSharedRedis } = require("../lib/redisClient");
const { buildCsv, attachJobReview } = require("./jobReviewHelper");
const { attachJobContract, backendJobIdFromUid } = require("./jobContract");
const { recordAuthEvent } = require("./authAuditService");
const { reserveCredits, settleCredits } = require("./hubCreditsService");
const { waitForHeavyOperationLease } = require("./mlHeavyOperationGovernor");

const QUEUE_NAME = "ml-modelo-massa";
const RESULT_TTL_SECONDS = Math.max(
  3600,
  Number(process.env.MODELO_MASSA_RESULT_TTL_SECONDS || 3 * 24 * 60 * 60),
);
const WORKER_CONCURRENCY = Math.max(
  1,
  Math.min(4, Number(process.env.MODELO_MASSA_WORKER_CONCURRENCY || 2)),
);
const META_UPDATE_EVERY = Math.max(
  1,
  Number(process.env.MODELO_MASSA_META_UPDATE_EVERY || 10),
);
const RESULT_FLUSH_EVERY = Math.max(
  10,
  Number(process.env.MODELO_MASSA_RESULT_FLUSH_EVERY || 100),
);

let queueInstance = null;
let redisInstance = null;
let workerStarted = false;

class ModeloMassaJobCancelledError extends Error {
  constructor(message = "Job de modelo em massa cancelado pelo usuario.") {
    super(message);
    this.name = "ModeloMassaJobCancelledError";
  }
}

function nowISO() {
  return new Date().toISOString();
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
  if (!redisInstance) redisInstance = getSharedRedis("modelo-massa:jobs");
  return redisInstance;
}

function resolveJobId(value) {
  return backendJobIdFromUid("modelo-massa", value);
}

function normalizeAccountKey(value) {
  const text = String(value || "").trim();
  if (!text || text.toLowerCase() === "default") return null;
  return text;
}

function metaKey(jobId) {
  return `ml:modelo-massa:${jobId}:meta`;
}

function resultsKey(jobId) {
  return `ml:modelo-massa:${jobId}:results`;
}

async function readMeta(jobId) {
  try {
    const raw = await getRedis().get(metaKey(jobId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function writeMeta(jobId, patch = {}) {
  const previous = (await readMeta(jobId)) || {};
  const merged = {
    ...previous,
    ...patch,
    updated_at: patch.updated_at || nowISO(),
  };
  await getRedis()
    .set(metaKey(jobId), JSON.stringify(merged), "EX", RESULT_TTL_SECONDS)
    .catch(() => {});
  return merged;
}

async function appendResults(jobId, rows = []) {
  const normalized = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!normalized.length) return;
  const redis = getRedis();
  await redis.rpush(resultsKey(jobId), ...normalized.map((row) => JSON.stringify(row)));
  await redis.expire(resultsKey(jobId), RESULT_TTL_SECONDS);
}

async function readResults(jobId) {
  try {
    const rows = await getRedis().lrange(resultsKey(jobId), 0, -1);
    return rows
      .map((row) => {
        try {
          return JSON.parse(row);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function resultCount(jobId) {
  try {
    return Math.max(0, Number(await getRedis().llen(resultsKey(jobId))) || 0);
  } catch {
    return 0;
  }
}

function safeText(value, max = 500) {
  const text = value == null ? "" : String(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function canAccessJob(job, accountKey) {
  const wanted = normalizeAccountKey(accountKey);
  const current = normalizeAccountKey(job?.data?.accountKey);
  return Boolean(wanted && current && wanted === current);
}

function accountFromData(data = {}) {
  const key = normalizeAccountKey(data.accountKey);
  const label = String(data.accountLabel || key || "").trim() || null;
  return key || label ? { key, label: label || key } : null;
}

function auditBase(data = {}, jobId = null) {
  const context = data.auditContext || {};
  return {
    userId: Number(context.userId) || null,
    email: context.email || null,
    ip: context.ip || null,
    userAgent: context.userAgent || null,
    accountKey: context.accountKey || data.accountKey || null,
    accountLabel: context.accountLabel || data.accountLabel || data.accountKey || null,
    meli_conta_id: context.meli_conta_id || data?.mlCreds?.meli_conta_id || null,
    route: context.route || null,
    method: context.method || null,
    job_id: jobId == null ? null : String(jobId),
    operation_id: data.operationId || null,
  };
}

async function auditModeloEvent(data, jobId, evento, status, metadata = {}) {
  const base = auditBase(data, jobId);
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
      job_id: base.job_id,
      operation_id: base.operation_id,
      action: "apply_model_mass",
      ...metadata,
    },
  }).catch((err) => {
    console.error("[ModeloMassaJobsService] audit erro:", err?.message || err);
  });
}

function telemetryFrom(job, meta = {}) {
  const reservation = job?.data?.creditReservation || {};
  return {
    billing_mode:
      reservation?.shadow === true
        ? "shadow"
        : reservation?.bypass === true
          ? "bypass"
          : "enforce",
    operation_key:
      job?.data?.billingOperationKey ||
      reservation?.quote?.operation_key ||
      reservation?.operation_key ||
      null,
    operation_id: job?.data?.operationId || null,
    selected: Number(meta.total || job?.data?.itemIds?.length || 0),
    processed: Number(meta.processed || 0),
    applied: Number(meta.applied || 0),
    manual: Number(meta.manual || 0),
    skipped: Number(meta.skipped || 0),
    errors: Number(meta.errors || 0),
    estimated_credits:
      reservation?.quote?.estimated_credits ??
      reservation?.reserved_credits ??
      null,
    duration_ms:
      meta.started_at && meta.finished_at
        ? Math.max(0, new Date(meta.finished_at).getTime() - new Date(meta.started_at).getTime())
        : null,
  };
}

async function shapeJob(job, { includeResults = false } = {}) {
  if (!job) return null;
  const meta = (await readMeta(job.id)) || {};
  const bullState = await job.getState().catch(() => "unknown");
  const total = Math.max(0, Number(meta.total || job.data?.itemIds?.length || 0));
  const processed = Math.max(0, Number(meta.processed || 0));
  const applied = Math.max(0, Number(meta.applied || 0));
  const manual = Math.max(0, Number(meta.manual || 0));
  const skipped = Math.max(0, Number(meta.skipped || 0));
  const errors = Math.max(0, Number(meta.errors || 0));
  const progress = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const status = String(
    meta.status ||
      (bullState === "completed"
        ? "concluido"
        : bullState === "failed"
          ? "erro"
          : bullState === "waiting" || bullState === "delayed"
            ? "aguardando"
            : "processando"),
  );
  const terminal = ["concluido", "cancelado", "erro"].includes(status);
  const resultsTotal = await resultCount(job.id);
  const publicJob = {
    id: String(job.id),
    title:
      job.data?.title ||
      `${job.data?.dryRun ? "Simular" : "Aplicar"} Modelo - ${total} item(ns)`,
    state:
      status === "concluido"
        ? `concluido: ${applied} aplicados, ${manual} manuais, ${errors} erros`
        : status === "processando"
          ? `processando ${processed}/${total}`
          : status,
    status,
    progress: terminal ? 100 : progress,
    processed,
    total,
    applied,
    manual,
    skipped,
    errors,
    dry_run: job.data?.dryRun === true,
    target_model: job.data?.targetModel || null,
    created_at: new Date(job.timestamp).toISOString(),
    updated_at: meta.updated_at || new Date(job.processedOn || job.timestamp).toISOString(),
    completed: terminal,
    account: accountFromData(job.data),
    result_total: resultsTotal,
    billing_telemetry: telemetryFrom(job, meta),
    queue_reason: meta.queueReason || null,
    heavy_operation_holder: meta.heavyOperationHolder || null,
    ...(includeResults ? { results: await readResults(job.id) } : {}),
  };

  return attachJobContract(
    attachJobReview(publicJob, {
      basePath: "/api/modelo-massa/jobs",
      hasCsv: resultsTotal > 0,
    }),
    { module: "modelo-massa" },
  );
}

async function runJob(job) {
  const data = job.data || {};
  const ids = Array.from(
    new Set(
      (Array.isArray(data.itemIds) ? data.itemIds : [])
        .map((value) => String(value || "").trim().toUpperCase())
        .filter(Boolean),
    ),
  );
  if (!ids.length) throw new Error("Nenhum anuncio informado para o job de modelo em massa.");

  const targetModel = String(data.targetModel || "").trim();
  if (!targetModel) throw new Error("Informe o valor do campo modelo.");

  const initialMeta = (await readMeta(job.id)) || {};
  if (initialMeta.cancelRequested === true || initialMeta.status === "cancelado") {
    throw new ModeloMassaJobCancelledError();
  }

  const startedAt = nowISO();
  await writeMeta(job.id, {
    status: "processando",
    state: "processando",
    total: ids.length,
    processed: 0,
    applied: 0,
    manual: 0,
    skipped: 0,
    errors: 0,
    cancelRequested: false,
    queueReason: null,
    heavyOperationHolder: null,
    started_at: startedAt,
  });
  await job.progress(0);

  await auditModeloEvent(data, job.id, "model_mass_job_started", "success", {
    total_items: ids.length,
    sample_ids: ids.slice(0, 20),
    target_model: targetModel,
    dry_run: data.dryRun === true,
    billing_telemetry: telemetryFrom(job, {
      total: ids.length,
      processed: 0,
      applied: 0,
      manual: 0,
      skipped: 0,
      errors: 0,
      started_at: startedAt,
    }),
  });

  const state = await ModeloMassaService.prepareState(data.mlCreds || {});
  let processed = 0;
  let applied = 0;
  let manual = 0;
  let skipped = 0;
  let errors = 0;
  let resultBuffer = [];

  for (const itemId of ids) {
    if (processed === 0 || processed % META_UPDATE_EVERY === 0) {
      const latestMeta = (await readMeta(job.id)) || {};
      if (latestMeta.cancelRequested === true || latestMeta.status === "cancelado") {
        throw new ModeloMassaJobCancelledError();
      }
    }

    let result;
    try {
      result = await ModeloMassaService.applyModelForItem(state, itemId, {
        target_model: targetModel,
        dry_run: data.dryRun === true,
      });
    } catch (error) {
      result = {
        id: itemId,
        status: "error",
        reason: error?.message || "Erro inesperado na execucao do job.",
      };
    }

    resultBuffer.push(result);
    processed += 1;

    await auditModeloEvent(
      data,
      job.id,
      "model_mass_item_processed",
      result.status === "applied" || result.status === "dry_run"
        ? "success"
        : result.status === "manual" || result.status === "skipped"
          ? "warn"
          : "error",
      {
        mlb_id: itemId,
        item_id: itemId,
        item_index: processed,
        total_items: ids.length,
        item_status: result.status,
        listing_type: result.listing_type || null,
        field: "MODEL",
        previous_value: result.current_model || null,
        requested_value: result.target_model || targetModel,
        applied_value: result.status === "applied" ? result.target_model || targetModel : null,
        retry_removed_attributes: result.retry_removed_attributes || null,
        user_product_conflict_id: result.user_product_conflict_id || null,
        recommended_action: result.recommended_action || null,
        ml_body: result.response || result.details || null,
        message: safeText(result.reason || result.message || ""),
      },
    );

    if (result.status === "applied") applied += 1;
    else if (result.status === "manual") manual += 1;
    else if (result.status === "skipped" || result.status === "dry_run") skipped += 1;
    else errors += 1;

    if (resultBuffer.length >= RESULT_FLUSH_EVERY) {
      await appendResults(job.id, resultBuffer);
      resultBuffer = [];
    }

    if (processed === 1 || processed === ids.length || processed % META_UPDATE_EVERY === 0) {
      await writeMeta(job.id, {
        status: "processando",
        state: `processando ${processed}/${ids.length}`,
        total: ids.length,
        processed,
        applied,
        manual,
        skipped,
        errors,
      });
      await job.progress(Math.min(100, Math.round((processed / ids.length) * 100)));
    }
  }

  if (resultBuffer.length) await appendResults(job.id, resultBuffer);

  const finishedAt = nowISO();
  const finalMeta = await writeMeta(job.id, {
    status: "concluido",
    state: `concluido: ${applied} aplicados, ${manual} manuais, ${errors} erros`,
    total: ids.length,
    processed,
    applied,
    manual,
    skipped,
    errors,
    finished_at: finishedAt,
    cancelRequested: false,
  });
  await job.progress(100);

  await auditModeloEvent(data, job.id, "model_mass_job_completed", errors > 0 ? "warn" : "success", {
    total_items: ids.length,
    processed,
    applied,
    manual,
    skipped,
    errors,
    target_model: targetModel,
    dry_run: data.dryRun === true,
    billing_telemetry: telemetryFrom(job, finalMeta),
  });

  return { ok: true, total: ids.length, processed, applied, manual, skipped, errors };
}

class ModeloMassaJobsService {
  static initWorker() {
    const queue = getQueue();
    if (workerStarted) return queue;
    workerStarted = true;

    queue.process(WORKER_CONCURRENCY, async (job) => {
      let heavyLease = null;
      let refreshTimer = null;
      try {
        heavyLease = await waitForHeavyOperationLease({
          accountKey: job.data?.accountKey,
          kind: job.data?.dryRun === true ? "mass-model-validation" : "mass-model",
          ownerId: `mass-model:${job.id}`,
          lane: job.data?.dryRun === true ? "read" : "write",
          metadata: {
            job_id: String(job.id),
            operation_id: job.data?.operationId || null,
            dry_run: job.data?.dryRun === true,
          },
          onWait: async (holder) => {
            await writeMeta(job.id, {
              status: "aguardando",
              state: "aguardando operacao pesada anterior",
              queueReason: "heavy_operation_busy",
              heavyOperationHolder: holder || null,
            });
          },
          shouldCancel: async () => {
            const meta = (await readMeta(job.id)) || {};
            return meta.cancelRequested === true || meta.status === "cancelado";
          },
        });

        refreshTimer = setInterval(() => {
          heavyLease?.refresh?.().catch(() => {});
        }, 60_000);
        refreshTimer.unref?.();

        return await runJob(job);
      } catch (rawError) {
        const error =
          rawError?.code === "HEAVY_OPERATION_WAIT_CANCELLED"
            ? new ModeloMassaJobCancelledError()
            : rawError;
        const meta = (await readMeta(job.id)) || {};

        if (error instanceof ModeloMassaJobCancelledError) {
          const finishedAt = nowISO();
          const cancelledMeta = await writeMeta(job.id, {
            status: "cancelado",
            state: "cancelado",
            finished_at: finishedAt,
            cancelRequested: false,
          });
          await job.progress(100);
          await auditModeloEvent(job.data || {}, job.id, "model_mass_job_canceled", "warn", {
            total_items: Number(meta.total || job.data?.itemIds?.length || 0),
            processed: Number(meta.processed || 0),
            applied: Number(meta.applied || 0),
            manual: Number(meta.manual || 0),
            skipped: Number(meta.skipped || 0),
            errors: Number(meta.errors || 0),
            billing_telemetry: telemetryFrom(job, cancelledMeta),
          });
          return {
            ok: false,
            cancelled: true,
            total: Number(meta.total || job.data?.itemIds?.length || 0),
            processed: Number(meta.processed || 0),
            applied: Number(meta.applied || 0),
            manual: Number(meta.manual || 0),
            skipped: Number(meta.skipped || 0),
            errors: Number(meta.errors || 0),
          };
        }

        const finishedAt = nowISO();
        const failedMeta = await writeMeta(job.id, {
          status: "erro",
          state: `erro: ${error?.message || error}`,
          finished_at: finishedAt,
          error: safeText(error?.message || String(error)),
          errors:
            Number(meta.errors || 0) +
            Math.max(1, Number(meta.total || job.data?.itemIds?.length || 0) - Number(meta.processed || 0)),
        });
        await job.progress(100).catch(() => {});
        await auditModeloEvent(job.data || {}, job.id, "model_mass_job_failed", "error", {
          total_items: Number(meta.total || job.data?.itemIds?.length || 0),
          processed: Number(meta.processed || 0),
          applied: Number(meta.applied || 0),
          manual: Number(meta.manual || 0),
          skipped: Number(meta.skipped || 0),
          errors: Number(failedMeta.errors || 0),
          target_model: job.data?.targetModel || null,
          billing_telemetry: telemetryFrom(job, failedMeta),
          error: safeText(error?.message || String(error)),
        });
        throw error;
      } finally {
        if (refreshTimer) clearInterval(refreshTimer);
        await heavyLease?.release?.().catch(() => {});
      }
    });

    queue.on("completed", async (job) => {
      const meta = (await readMeta(job.id)) || {};
      const processed = Math.max(0, Number(meta.processed || 0));
      await settleCredits(job?.data?.creditReservation, {
        release: processed <= 0,
        consumedUnits: processed > 0 ? processed : null,
      }).catch(() => {});
    });

    queue.on("failed", async (job, error) => {
      console.error("[ModeloMassaJobsService] job failed:", job?.id, error?.message || error);
      const meta = (await readMeta(job.id)) || {};
      const processed = Math.max(0, Number(meta.processed || 0));
      await settleCredits(job?.data?.creditReservation, {
        release: processed <= 0,
        consumedUnits: processed > 0 ? processed : null,
      }).catch(() => {});
    });

    console.log(
      `[ModeloMassaJobsService] worker Bull inicializado (concurrency=${WORKER_CONCURRENCY})`,
    );
    return queue;
  }

  static async enqueue({
    itemIds = [],
    targetModel = "",
    dryRun = false,
    mlCreds = {},
    accountKey = null,
    accountLabel = null,
    auditContext = null,
  }) {
    const ids = Array.from(
      new Set(
        (itemIds || [])
          .map((value) => String(value || "").trim().toUpperCase())
          .filter(Boolean),
      ),
    );

    if (!ids.length) {
      throw new Error("Nenhum anuncio informado para o job de modelo em massa.");
    }
    if (!String(targetModel || "").trim()) {
      throw new Error("Informe o valor do campo modelo.");
    }

    const normalizedAccountKey =
      normalizeAccountKey(accountKey) ||
      normalizeAccountKey(mlCreds?.meli_user_id) ||
      normalizeAccountKey(mlCreds?.meli_conta_id);
    if (!normalizedAccountKey) {
      throw new Error("Conta obrigatoria para iniciar job de modelo em massa.");
    }

    const operationId = `MODEL-${crypto.randomUUID()}`;
    const billingOperationKey = "mass-model.apply";
    const creditReservation = await reserveCredits({
      mlCreds,
      operationKey: billingOperationKey,
      units: ids.length,
      idempotencyKey: `mass-model:${operationId}`,
    });

    let job;
    try {
      job = await getQueue().add(
        {
          kind: "modelo_massa",
          title: `${dryRun ? "Simular" : "Aplicar"} Modelo - ${ids.length} item(ns)`,
          itemIds: ids,
          targetModel: String(targetModel).trim(),
          dryRun: dryRun === true,
          mlCreds,
          accountKey: normalizedAccountKey,
          accountLabel: accountLabel || normalizedAccountKey,
          auditContext: auditContext && typeof auditContext === "object" ? auditContext : null,
          creditReservation,
          operationId,
          billingOperationKey,
        },
        {
          jobId: `job_modelo_${operationId}`,
          attempts: 1,
          removeOnComplete: false,
          removeOnFail: false,
        },
      );

      await writeMeta(job.id, {
        status: "aguardando",
        state: "aguardando",
        total: ids.length,
        processed: 0,
        applied: 0,
        manual: 0,
        skipped: 0,
        errors: 0,
        cancelRequested: false,
        created_at: nowISO(),
      });
    } catch (error) {
      await settleCredits(creditReservation, { release: true }).catch(() => {});
      throw error;
    }

    return shapeJob(job);
  }

  static async listRecent(limit = 20, { accountKey = null } = {}) {
    const jobs = await getQueue().getJobs(
      ["active", "waiting", "delayed", "failed", "completed"],
      0,
      Math.max(0, Number(limit || 20) - 1),
      false,
    );
    const mapped = await Promise.all(
      jobs
        .filter((job) => canAccessJob(job, accountKey))
        .map((job) => shapeJob(job)),
    );
    return mapped
      .filter(Boolean)
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
      .slice(0, Math.max(1, Number(limit || 20)));
  }

  static async jobDetail(id, { accountKey = null } = {}) {
    const job = await getQueue().getJob(resolveJobId(id));
    if (!job || !canAccessJob(job, accountKey)) return null;
    return shapeJob(job, { includeResults: true });
  }

  static async cancelJob(id, { accountKey = null } = {}) {
    const job = await getQueue().getJob(resolveJobId(id));
    if (!job || !canAccessJob(job, accountKey)) return null;

    const state = await job.getState().catch(() => "unknown");
    const meta = (await readMeta(job.id)) || {};
    if (["completed", "failed"].includes(state) || ["concluido", "cancelado", "erro"].includes(meta.status)) {
      return { ok: false, status: meta.status || state, error: "Job ja finalizado." };
    }

    if (["waiting", "delayed"].includes(state)) {
      await writeMeta(job.id, {
        status: "cancelado",
        state: "cancelado",
        cancelRequested: false,
        finished_at: nowISO(),
      });
      await settleCredits(job?.data?.creditReservation, { release: true }).catch(() => {});
      await job.remove();
      return { ok: true, status: "cancelado" };
    }

    await writeMeta(job.id, {
      status: "cancelando",
      state: "cancelando",
      cancelRequested: true,
    });
    return { ok: true, status: "cancelando" };
  }

  static async getJobCsv(id, { accountKey = null } = {}) {
    const job = await getQueue().getJob(resolveJobId(id));
    if (!job || !canAccessJob(job, accountKey)) return null;

    const rows = await readResults(job.id);
    if (!rows.length) return null;
    const csv = buildCsv(
      rows.map((row) => [
        row?.id || "",
        row?.status || "",
        row?.reason || row?.message || "",
        row?.current_model || "",
        row?.target_model || "",
        row?.listing_type || "",
        row?.user_product_conflict_id || "",
        row?.recommended_action || "",
        Array.isArray(row?.retry_removed_attributes)
          ? row.retry_removed_attributes.join("|")
          : "",
      ]),
      [
        "mlb_id",
        "status",
        "message",
        "modelo_anterior",
        "modelo_solicitado",
        "tipo_anuncio",
        "user_product_conflict_id",
        "recommended_action",
        "atributos_removidos_retry",
      ],
    );

    return {
      filename: `modelo_massa_${job.id}.csv`,
      csv: `\ufeff${csv}`,
    };
  }
}

module.exports = ModeloMassaJobsService;
