"use strict";

const Bull = require("bull");
const crypto = require("crypto");
const AtacadoService = require("./atacadoService");
const { makeBullClient, getSharedRedis } = require("../lib/redisClient");
const { buildCsv, attachJobReview } = require("./jobReviewHelper");
const { attachJobContract, backendJobIdFromUid } = require("./jobContract");
const { recordAuthEvent } = require("./authAuditService");
const { reserveCredits, settleCredits } = require("./hubCreditsService");
const { waitForHeavyOperationLease } = require("./mlHeavyOperationGovernor");

const QUEUE_NAME = "ml-atacado";
const RESULT_TTL_SECONDS = Math.max(
  3600,
  Number(process.env.ATACADO_RESULT_TTL_SECONDS || 3 * 24 * 60 * 60),
);
const WORKER_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.ATACADO_WORKER_CONCURRENCY || 2)),
);
const META_UPDATE_EVERY = Math.max(
  1,
  Number(process.env.ATACADO_META_UPDATE_EVERY || 10),
);
const RESULT_FLUSH_EVERY = Math.max(
  10,
  Number(process.env.ATACADO_RESULT_FLUSH_EVERY || 100),
);

let queueInstance = null;
let workerStarted = false;
let redisInstance = null;

class AtacadoJobCancelledError extends Error {
  constructor(message = "Job de atacado cancelado pelo usuario.") {
    super(message);
    this.name = "AtacadoJobCancelledError";
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
  if (!redisInstance) redisInstance = getSharedRedis("atacado:jobs");
  return redisInstance;
}

function resolveJobId(value) {
  return backendJobIdFromUid("atacado", value);
}

function normalizeAccountKey(value) {
  const text = String(value || "").trim();
  if (!text || text.toLowerCase() === "default") return null;
  return text;
}

function metaKey(jobId) {
  return `ml:atacado:${jobId}:meta`;
}

function resultsKey(jobId) {
  return `ml:atacado:${jobId}:results`;
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
  const payload = normalized.map((row) => JSON.stringify(row));
  await redis.rpush(resultsKey(jobId), ...payload);
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

function round2(value) {
  const num = Number(value || 0);
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function safeText(value, max = 500) {
  const text = value == null ? "" : String(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function tierSummaryFromConfigs(tierConfigs = []) {
  const tiers = Array.isArray(tierConfigs)
    ? tierConfigs
        .map((tier) => ({
          min_purchase_unit: Number(tier?.min_purchase_unit || 0) || null,
          discount_percent: Number(tier?.discount_percent || 0) || null,
        }))
        .filter((tier) => tier.min_purchase_unit != null || tier.discount_percent != null)
    : [];
  const discounts = tiers
    .map((tier) => Number(tier.discount_percent))
    .filter((value) => Number.isFinite(value));
  return {
    tiers,
    tier_count: tiers.length,
    min_discount_percent: discounts.length ? Math.min(...discounts) : null,
    max_discount_percent: discounts.length ? Math.max(...discounts) : null,
  };
}

function tierSummaryFromResult(result = {}) {
  const baseAmount = Number(result?.row?.sale_price || 0) || null;
  const prices = Array.isArray(result?.payload?.prices) ? result.payload.prices : [];
  const tiers = prices.map((price) => {
    const amount = Number(price?.amount || 0) || null;
    const discount =
      baseAmount && amount
        ? round2(100 * (1 - amount / baseAmount))
        : null;
    return {
      min_purchase_unit: Number(price?.conditions?.min_purchase_unit || 0) || null,
      amount,
      discount_percent: discount,
      currency_id: price?.currency_id || result?.row?.currency_id || "BRL",
    };
  });
  const discounts = tiers
    .map((tier) => Number(tier.discount_percent))
    .filter((value) => Number.isFinite(value));
  return {
    tiers,
    tier_count: tiers.length,
    min_discount_percent: discounts.length ? Math.min(...discounts) : null,
    max_discount_percent: discounts.length ? Math.max(...discounts) : null,
    base_price: baseAmount,
  };
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
    meli_conta_id: context.meli_conta_id || null,
    route: context.route || null,
    method: context.method || null,
    job_id: jobId == null ? null : String(jobId),
    operation_id: data.operationId || null,
  };
}

async function auditAtacadoEvent(data, jobId, evento, status, metadata = {}) {
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
      action: "apply_wholesale_price",
      ...metadata,
    },
  }).catch((err) => {
    console.error("[AtacadoJobsService] audit erro:", err?.message || err);
  });
}

function accountFromData(data = {}) {
  const key = normalizeAccountKey(data.accountKey);
  const label = String(data.accountLabel || key || "").trim() || null;
  return key || label ? { key, label: label || key } : null;
}

function canAccessJob(job, accountKey) {
  const wanted = normalizeAccountKey(accountKey);
  const current = normalizeAccountKey(job?.data?.accountKey);
  return Boolean(wanted && current && wanted === current);
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
            : "processando")
  );
  const terminal = ["concluido", "cancelado", "erro"].includes(status);
  const resultTotal = await resultCount(job.id);
  const publicJob = {
    id: String(job.id),
    title:
      job.data?.title ||
      `${job.data?.dryRun ? "Simular" : "Aplicar"} Atacado - ${total} item(ns)`,
    state:
      status === "concluido"
        ? `concluido: ${applied} ok, ${errors} erros, ${skipped} ignorados`
        : status === "processando"
          ? `processando ${processed}/${total}`
          : status,
    status,
    progress: terminal ? 100 : progress,
    processed,
    total,
    applied,
    skipped,
    errors,
    dry_run: job.data?.dryRun === true,
    created_at: new Date(job.timestamp).toISOString(),
    updated_at: meta.updated_at || new Date(job.processedOn || job.timestamp).toISOString(),
    completed: terminal,
    account: accountFromData(job.data),
    result_total: resultTotal,
    billing_telemetry: telemetryFrom(job, meta),
    queue_reason: meta.queueReason || null,
    heavy_operation_holder: meta.heavyOperationHolder || null,
    ...(includeResults ? { results: await readResults(job.id) } : {}),
  };
  return attachJobContract(
    attachJobReview(publicJob, {
      basePath: "/api/atacado/jobs",
      hasCsv: resultTotal > 0,
    }),
    { module: "atacado" },
  );
}

async function runJob(job) {
  const data = job.data || {};
  const initialMeta = (await readMeta(job.id)) || {};
  if (initialMeta.cancelRequested === true || initialMeta.status === "cancelado") {
    throw new AtacadoJobCancelledError();
  }
  const ids = Array.from(
    new Set(
      (Array.isArray(data.itemIds) ? data.itemIds : [])
        .map((value) => String(value || "").trim().toUpperCase())
        .filter(Boolean),
    ),
  );
  if (!ids.length) throw new Error("Nenhum anuncio informado para o job de atacado.");

  const dryRun = data.dryRun === true;
  const applyOptions = {
    extra_discount_percent: data.extraDiscountPercent,
    min_purchase_unit: data.minPurchaseUnit,
    tier_configs: data.tierConfigs,
    promo_only: data.promoOnly !== false,
    dry_run: dryRun,
  };
  const requestedTierSummary = tierSummaryFromConfigs(
    Array.isArray(data.tierConfigs) && data.tierConfigs.length
      ? data.tierConfigs
      : [{
          min_purchase_unit: data.minPurchaseUnit,
          discount_percent: data.extraDiscountPercent,
        }],
  );

  const startedAt = nowISO();
  await writeMeta(job.id, {
    status: "processando",
    total: ids.length,
    processed: 0,
    applied: 0,
    skipped: 0,
    errors: 0,
    cancelRequested: false,
    queueReason: null,
    heavyOperationHolder: null,
    started_at: startedAt,
  });
  await job.progress(0);

  await auditAtacadoEvent(data, job.id, "wholesale_price_job_started", "success", {
    total_items: ids.length,
    sample_ids: ids.slice(0, 20),
    dry_run: dryRun,
    promo_only: data.promoOnly !== false,
    extra_discount_percent: Number(data.extraDiscountPercent),
    min_purchase_unit: Number(data.minPurchaseUnit),
    wholesale_tier_count: requestedTierSummary.tier_count,
    wholesale_tiers: requestedTierSummary.tiers,
    wholesale_min_discount_percent: requestedTierSummary.min_discount_percent,
    wholesale_max_discount_percent: requestedTierSummary.max_discount_percent,
    billing_telemetry: telemetryFrom(job, {
      total: ids.length,
      processed: 0,
      applied: 0,
      skipped: 0,
      errors: 0,
      started_at: startedAt,
    }),
  });

  const state = await AtacadoService.prepareState(data.mlCreds || {});
  let processed = 0;
  let applied = 0;
  let skipped = 0;
  let errors = 0;
  let resultBuffer = [];

  for (const itemId of ids) {
    if (processed === 0 || processed % META_UPDATE_EVERY === 0) {
      const latestMeta = (await readMeta(job.id)) || {};
      if (latestMeta.cancelRequested === true || latestMeta.status === "cancelado") {
        throw new AtacadoJobCancelledError();
      }
    }

    let result;
    try {
      result = await AtacadoService.applyWholesaleForItem(state, itemId, applyOptions);
    } catch (error) {
      result = {
        id: itemId,
        status: "error",
        reason: error?.message || "Erro inesperado na execucao do job.",
      };
    }

    resultBuffer.push(result);
    processed += 1;
    const appliedTierSummary = tierSummaryFromResult(result);

    await auditAtacadoEvent(
      data,
      job.id,
      "wholesale_price_item_processed",
      result.status === "applied" || result.status === "dry_run"
        ? "success"
        : result.status === "skipped"
          ? "warn"
          : "error",
      {
        mlb_id: itemId,
        item_id: itemId,
        item_index: processed,
        total_items: ids.length,
        item_status: result.status,
        message: safeText(result.reason || result.message || ""),
        promo_only: data.promoOnly !== false,
        dry_run: dryRun,
        promo_active: result?.row?.promo_active ?? null,
        promo_percent: result?.row?.promo_percent ?? null,
        item_price: result?.row?.item_price ?? null,
        sale_price: result?.row?.sale_price ?? null,
        wholesale_base_price: appliedTierSummary.base_price,
        wholesale_tier_count: appliedTierSummary.tier_count,
        wholesale_tiers: appliedTierSummary.tiers,
        wholesale_min_discount_percent: appliedTierSummary.min_discount_percent,
        wholesale_max_discount_percent: appliedTierSummary.max_discount_percent,
        requested_tiers: requestedTierSummary.tiers,
      },
    );

    if (result.status === "applied") applied += 1;
    else if (result.status === "skipped" || result.status === "dry_run") skipped += 1;
    else errors += 1;

    if (resultBuffer.length >= RESULT_FLUSH_EVERY) {
      await appendResults(job.id, resultBuffer);
      resultBuffer = [];
    }

    if (processed === 1 || processed === ids.length || processed % META_UPDATE_EVERY === 0) {
      await writeMeta(job.id, {
        status: "processando",
        total: ids.length,
        processed,
        applied,
        skipped,
        errors,
      });
      await job.progress(Math.min(100, Math.round((processed / ids.length) * 100)));
    }
  }

  if (resultBuffer.length) await appendResults(job.id, resultBuffer);

  const finishedAt = nowISO();
  await writeMeta(job.id, {
    status: "concluido",
    total: ids.length,
    processed,
    applied,
    skipped,
    errors,
    finished_at: finishedAt,
    cancelRequested: false,
  });
  await job.progress(100);

  await auditAtacadoEvent(
    data,
    job.id,
    "wholesale_price_job_completed",
    errors > 0 ? "warn" : "success",
    {
      total_items: ids.length,
      processed,
      applied,
      skipped,
      errors,
      dry_run: dryRun,
      promo_only: data.promoOnly !== false,
      wholesale_tier_count: requestedTierSummary.tier_count,
      wholesale_tiers: requestedTierSummary.tiers,
      billing_telemetry: telemetryFrom(job, {
        total: ids.length,
        processed,
        applied,
        skipped,
        errors,
        started_at: startedAt,
        finished_at: finishedAt,
      }),
    },
  );

  return { ok: true, total: ids.length, processed, applied, skipped, errors };
}

class AtacadoJobsService {
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
          kind: job.data?.dryRun === true ? "wholesale-validation" : "wholesale",
          ownerId: `wholesale:${job.id}`,
          metadata: {
            job_id: String(job.id),
            dry_run: job.data?.dryRun === true,
          },
          lane: job.data?.dryRun === true ? "read" : "write",
          onWait: async (holder) => {
            await writeMeta(job.id, {
              status: "aguardando",
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
            ? new AtacadoJobCancelledError()
            : rawError;
        const meta = (await readMeta(job.id)) || {};
        if (error instanceof AtacadoJobCancelledError) {
          const finishedAt = nowISO();
          await writeMeta(job.id, {
            status: "cancelado",
            finished_at: finishedAt,
            cancelRequested: false,
          });
          await job.progress(100);
          await auditAtacadoEvent(job.data || {}, job.id, "wholesale_price_job_canceled", "warn", {
            total_items: Number(meta.total || job.data?.itemIds?.length || 0),
            processed: Number(meta.processed || 0),
            applied: Number(meta.applied || 0),
            skipped: Number(meta.skipped || 0),
            errors: Number(meta.errors || 0),
            billing_telemetry: telemetryFrom(job, {
              ...meta,
              finished_at: finishedAt,
            }),
          });
          return {
            ok: false,
            cancelled: true,
            total: Number(meta.total || job.data?.itemIds?.length || 0),
            processed: Number(meta.processed || 0),
            applied: Number(meta.applied || 0),
            skipped: Number(meta.skipped || 0),
            errors: Number(meta.errors || 0),
          };
        }

        await writeMeta(job.id, {
          status: "erro",
          finished_at: nowISO(),
          error: safeText(error?.message || String(error)),
        });
        await auditAtacadoEvent(job.data || {}, job.id, "wholesale_price_job_failed", "error", {
          total_items: Number(meta.total || job.data?.itemIds?.length || 0),
          processed: Number(meta.processed || 0),
          applied: Number(meta.applied || 0),
          skipped: Number(meta.skipped || 0),
          errors: Number(meta.errors || 0),
          billing_telemetry: telemetryFrom(job, {
            ...meta,
            finished_at: nowISO(),
          }),
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
      console.error("[AtacadoJobsService] job failed:", job?.id, error?.message || error);
      const meta = (await readMeta(job.id)) || {};
      const processed = Math.max(0, Number(meta.processed || 0));
      await settleCredits(job?.data?.creditReservation, {
        release: processed <= 0,
        consumedUnits: processed > 0 ? processed : null,
      }).catch(() => {});
    });

    console.log(
      `[AtacadoJobsService] worker Bull inicializado (concurrency=${WORKER_CONCURRENCY})`,
    );
    return queue;
  }

  static async enqueue({
    itemIds = [],
    extraDiscountPercent = 1,
    minPurchaseUnit = 2,
    tierConfigs = null,
    promoOnly = true,
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
    const normalizedAccount = normalizeAccountKey(accountKey);
    if (!ids.length) throw new Error("Nenhum anuncio informado para o job de atacado.");
    if (!normalizedAccount) throw new Error("Conta obrigatoria para iniciar job de atacado.");

    const operationId = `WHOLESALE-${crypto.randomUUID()}`;
    const billingOperationKey = dryRun ? "wholesale.validate" : "wholesale.apply";
    const creditReservation = await reserveCredits({
      mlCreds,
      operationKey: billingOperationKey,
      units: ids.length,
      idempotencyKey: `wholesale:${operationId}`,
    });

    const queue = getQueue();
    let job;
    try {
      job = await queue.add(
        {
          kind: "atacado",
          operationId,
          billingOperationKey,
          title: `${dryRun ? "Simular" : "Aplicar"} Atacado - ${ids.length} item(ns)`,
          itemIds: ids,
          extraDiscountPercent: Number(extraDiscountPercent),
          minPurchaseUnit: Number(minPurchaseUnit),
          tierConfigs: Array.isArray(tierConfigs) ? tierConfigs : null,
          promoOnly: promoOnly !== false,
          dryRun: dryRun === true,
          mlCreds,
          accountKey: normalizedAccount,
          accountLabel: accountLabel || normalizedAccount,
          auditContext: auditContext && typeof auditContext === "object" ? auditContext : null,
          creditReservation,
          createdAt: Date.now(),
        },
        {
          jobId: `job_atacado_${operationId}`,
          attempts: 1,
          removeOnComplete: 200,
          removeOnFail: false,
        },
      );

      await writeMeta(job.id, {
        status: "aguardando",
        total: ids.length,
        processed: 0,
        applied: 0,
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
    const queue = getQueue();
    const jobs = await queue.getJobs(
      ["active", "waiting", "delayed", "failed", "completed"],
      0,
      Math.max(0, Number(limit || 20) - 1),
      false,
    );
    const scoped = jobs.filter((job) => canAccessJob(job, accountKey));
    const mapped = await Promise.all(scoped.map((job) => shapeJob(job)));
    return mapped.filter(Boolean);
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

    const cancelBeforeProcessing =
      ["waiting", "delayed"].includes(state) && Number(meta.processed || 0) <= 0;
    await writeMeta(job.id, {
      status: cancelBeforeProcessing ? "cancelado" : "cancelando",
      cancelRequested: true,
      cancel_requested: true,
    });
    if (cancelBeforeProcessing) {
      await settleCredits(job?.data?.creditReservation, { release: true }).catch(() => {});
    }

    return {
      ok: true,
      status: cancelBeforeProcessing ? "cancelado" : "cancelando",
    };
  }

  static async getJobCsv(id, { accountKey = null } = {}) {
    const job = await getQueue().getJob(resolveJobId(id));
    if (!job || !canAccessJob(job, accountKey)) return null;
    const rows = await readResults(job.id);
    const csv = buildCsv(
      rows.map((row) => {
        const summary = tierSummaryFromResult(row);
        return [
          row?.id || "",
          row?.status || "",
          row?.reason || row?.message || "",
          row?.row?.promo_active ?? "",
          row?.row?.promo_percent ?? "",
          row?.row?.item_price ?? "",
          row?.row?.sale_price ?? "",
          summary.base_price ?? "",
          summary.tier_count ?? "",
          summary.min_discount_percent ?? "",
          summary.max_discount_percent ?? "",
          JSON.stringify(summary.tiers || []),
        ];
      }),
      [
        "mlb_id",
        "status",
        "message",
        "promo_ativa",
        "promo_percentual",
        "preco_item",
        "preco_promocional",
        "preco_base_atacado",
        "qtd_faixas",
        "menor_percentual_faixa",
        "maior_percentual_faixa",
        "faixas_json",
      ],
    );

    return {
      filename: `atacado_${job.id}.csv`,
      csv: `\ufeff${csv}`,
    };
  }
}

module.exports = AtacadoJobsService;
