"use strict";

const AtacadoService = require("./atacadoService");
const { buildCsv, attachJobReview } = require("./jobReviewHelper");
const { attachJobContract, backendJobIdFromUid } = require("./jobContract");
const { recordAuthEvent } = require("./authAuditService");
const { reserveCredits, settleCredits } = require("./hubCreditsService");

const JOBS = new Map();
const TTL_MS = 24 * 60 * 60 * 1000;

function nowISO() {
  return new Date().toISOString();
}

function gc() {
  const now = Date.now();
  for (const [id, job] of JOBS.entries()) {
    const ref = new Date(job.updated_at || job.created_at || Date.now()).getTime();
    if (now - ref > TTL_MS) JOBS.delete(id);
  }
}

function makeId() {
  return `job_atacado_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function shapeForList(job) {
  return attachJobContract(attachJobReview({
    id: job.id,
    title: job.title,
    state: job.state,
    status: job.state,
    progress: job.progress,
    processed: job.processed,
    total: job.total,
    errors: job.errors,
    skipped: job.skipped,
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed: !!job.completed,
    account: job.account || null,
  }, {
    basePath: "/api/atacado/jobs",
    hasCsv: Array.isArray(job.results),
  }), { module: "atacado" });
}

function resolveJobId(value) {
  return backendJobIdFromUid("atacado", value);
}

function normalizeAccountKey(value) {
  const text = String(value || "").trim();
  return text || null;
}

function canAccessJob(job, accountKey) {
  const wanted = normalizeAccountKey(accountKey);
  const current = normalizeAccountKey(job?.account?.key);
  if (!wanted) return false;
  if (!current) return false;
  if (current === "default") return false;
  return current === wanted;
}

function isTerminalState(text) {
  return /conclu|erro|failed|falhou/i.test(String(text || ""));
}

function shapeForDetail(job) {
  if (!job) return null;
  const { auditContext, creditReservation, ...publicJob } = job;
  return attachJobContract(attachJobReview({ ...publicJob }, {
    basePath: "/api/atacado/jobs",
    hasCsv: Array.isArray(job.results),
  }), { module: "atacado" });
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

function auditBase(job = {}) {
  const context = job.auditContext || {};
  return {
    userId: Number(context.userId) || null,
    email: context.email || null,
    ip: context.ip || null,
    userAgent: context.userAgent || null,
    accountKey: context.accountKey || job.account?.key || null,
    accountLabel: context.accountLabel || job.account?.label || null,
    meli_conta_id: context.meli_conta_id || null,
    route: context.route || null,
    method: context.method || null,
    job_id: job.id || null,
  };
}

async function auditAtacadoEvent(job, evento, status, metadata = {}) {
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
      job_id: base.job_id,
      action: "apply_wholesale_price",
      ...metadata,
    },
  }).catch((err) => {
    console.error("[AtacadoJobsService] audit erro:", err?.message || err);
  });
}

class AtacadoJobsService {
  static listRecent(limit = 20, { accountKey = null } = {}) {
    gc();
    return [...JOBS.values()]
      .filter((job) => canAccessJob(job, accountKey))
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
      .slice(0, limit)
      .map(shapeForList);
  }

  static jobDetail(id, { accountKey = null } = {}) {
    gc();
    const job = JOBS.get(resolveJobId(id));
    return job && canAccessJob(job, accountKey) ? shapeForDetail(job) : null;
  }

  static cancelJob(id, { accountKey = null } = {}) {
    gc();
    const job = JOBS.get(resolveJobId(id));
    if (!job || !canAccessJob(job, accountKey)) return null;
    if (job.completed) {
      return { ok: false, status: "completed", error: "Job ja finalizado." };
    }

    if (job.state === "aguardando") {
      job.state = "cancelado";
      job.progress = 100;
      job.completed = true;
      job.cancel_requested = false;
      job.updated_at = nowISO();
      JOBS.set(job.id, job);
      return { ok: true, status: "cancelado" };
    }

    job.cancel_requested = true;
    job.state = "cancelando";
    job.updated_at = nowISO();
    JOBS.set(job.id, job);
    return { ok: true, status: "cancelando" };
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
      new Set((itemIds || []).map((value) => String(value || "").trim().toUpperCase()).filter(Boolean)),
    );

    if (!ids.length) {
      throw new Error("Nenhum anúncio informado para o job de atacado.");
    }

    const creditReservation = await reserveCredits({
      mlCreds,
      operationKey: "wholesale.apply",
      units: ids.length,
    });

    const id = makeId();
    const job = {
      id,
      kind: "atacado",
      title: `${dryRun ? "Simular" : "Aplicar"} Atacado - ${ids.length} item(ns)`,
      state: "aguardando",
      progress: 0,
      total: ids.length,
      processed: 0,
      applied: 0,
      skipped: 0,
      errors: 0,
      dry_run: dryRun,
      results: [],
      options: {
        extra_discount_percent: Number(extraDiscountPercent),
        min_purchase_unit: Number(minPurchaseUnit),
        tier_configs: Array.isArray(tierConfigs) ? tierConfigs : null,
        promo_only: !!promoOnly,
      },
      account: accountKey || accountLabel
        ? { key: accountKey || null, label: accountLabel || accountKey || null }
        : null,
      auditContext: auditContext && typeof auditContext === "object" ? auditContext : null,
      creditReservation,
      created_at: nowISO(),
      updated_at: nowISO(),
      completed: false,
    };

    JOBS.set(id, job);

    (async () => {
      try {
        const state = await AtacadoService.prepareState(mlCreds);
        const applyOptions = {
          extra_discount_percent: extraDiscountPercent,
          min_purchase_unit: minPurchaseUnit,
          tier_configs: tierConfigs,
          promo_only: promoOnly,
          dry_run: dryRun,
        };
        const requestedTierSummary = tierSummaryFromConfigs(
          Array.isArray(tierConfigs) && tierConfigs.length
            ? tierConfigs
            : [
                {
                  min_purchase_unit: minPurchaseUnit,
                  discount_percent: extraDiscountPercent,
                },
              ],
        );
        await auditAtacadoEvent(job, "wholesale_price_job_started", "success", {
          total_items: ids.length,
          sample_ids: ids.slice(0, 20),
          dry_run: dryRun,
          promo_only: !!promoOnly,
          extra_discount_percent: Number(extraDiscountPercent),
          min_purchase_unit: Number(minPurchaseUnit),
          wholesale_tier_count: requestedTierSummary.tier_count,
          wholesale_tiers: requestedTierSummary.tiers,
          wholesale_min_discount_percent: requestedTierSummary.min_discount_percent,
          wholesale_max_discount_percent: requestedTierSummary.max_discount_percent,
        });

        for (const itemId of ids) {
          if (job.cancel_requested) {
            job.state = "cancelado";
            job.progress = 100;
            job.completed = true;
            job.updated_at = nowISO();
            JOBS.set(id, job);
            await settleCredits(job.creditReservation, {
              release: job.processed === 0,
            });
            return;
          }
          job.state = `processando ${job.processed + 1}/${job.total}`;
          job.updated_at = nowISO();
          JOBS.set(id, job);

          let result;
          try {
            result = await AtacadoService.applyWholesaleForItem(
              state,
              itemId,
              applyOptions,
            );
          } catch (error) {
            result = {
              id: itemId,
              status: "error",
              reason: error?.message || "Erro inesperado na execução do job.",
            };
          }

          job.results.push(result);
          job.processed += 1;
          const appliedTierSummary = tierSummaryFromResult(result);
          await auditAtacadoEvent(
            job,
            "wholesale_price_item_processed",
            result.status === "applied" || result.status === "dry_run"
              ? "success"
              : result.status === "skipped"
                ? "warn"
                : "error",
            {
              mlb_id: itemId,
              item_id: itemId,
              item_index: job.processed,
              total_items: job.total,
              item_status: result.status,
              message: safeText(result.reason || result.message || ""),
              promo_only: !!promoOnly,
              dry_run: !!dryRun,
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
              requested_min_discount_percent: requestedTierSummary.min_discount_percent,
              requested_max_discount_percent: requestedTierSummary.max_discount_percent,
            },
          );

          if (result.status === "applied") job.applied += 1;
          else if (result.status === "skipped" || result.status === "dry_run") {
            job.skipped += 1;
          } else if (result.status === "error") {
            job.errors += 1;
          }

          job.progress = Math.round((job.processed / job.total) * 100);
          job.updated_at = nowISO();
          JOBS.set(id, job);
        }

        job.state = `concluído: ${job.applied} ok, ${job.errors} erros, ${job.skipped} ignorados`;
        job.progress = 100;
        job.completed = true;
        job.updated_at = nowISO();
        JOBS.set(id, job);
        await settleCredits(job.creditReservation, { release: false });
        await auditAtacadoEvent(job, "wholesale_price_job_completed", job.errors > 0 ? "warn" : "success", {
          total_items: job.total,
          processed: job.processed,
          applied: job.applied,
          skipped: job.skipped,
          errors: job.errors,
          dry_run: dryRun,
          promo_only: !!promoOnly,
          wholesale_tier_count: requestedTierSummary.tier_count,
          wholesale_tiers: requestedTierSummary.tiers,
          wholesale_min_discount_percent: requestedTierSummary.min_discount_percent,
          wholesale_max_discount_percent: requestedTierSummary.max_discount_percent,
        });
      } catch (error) {
        job.state = `erro: ${error?.message || error}`;
        job.progress = 100;
        job.completed = true;
        job.errors += Math.max(1, job.total - job.processed);
        job.updated_at = nowISO();
        JOBS.set(id, job);
        await settleCredits(job.creditReservation, {
          release: job.processed === 0,
        });
        await auditAtacadoEvent(job, "wholesale_price_job_failed", "error", {
          total_items: job.total,
          processed: job.processed,
          applied: job.applied,
          skipped: job.skipped,
          errors: job.errors,
          error: safeText(error?.message || String(error)),
        });
      }
    })();

    return shapeForList(job);
  }

  static getJobCsv(id, { accountKey = null } = {}) {
    gc();
    const job = JOBS.get(resolveJobId(id));
    if (!job || !canAccessJob(job, accountKey)) return null;

    const rows = Array.isArray(job.results) ? job.results : [];
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
