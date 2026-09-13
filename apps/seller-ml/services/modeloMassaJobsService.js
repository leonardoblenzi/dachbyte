"use strict";

const ModeloMassaService = require("./modeloMassaService");
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
  return `job_modelo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
    applied: job.applied,
    manual: job.manual,
    skipped: job.skipped,
    errors: job.errors,
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed: !!job.completed,
    account: job.account || null,
  }, {
    basePath: "/api/modelo-massa/jobs",
    hasCsv: Array.isArray(job.results),
  }), { module: "modelo-massa" });
}

function resolveJobId(value) {
  return backendJobIdFromUid("modelo-massa", value);
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

function safeText(value, max = 500) {
  const text = value == null ? "" : String(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
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
  };
}

async function auditModeloEvent(job, evento, status, metadata = {}) {
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
      job_id: job.id || null,
      action: "apply_model_mass",
      ...metadata,
    },
  }).catch((err) => {
    console.error("[ModeloMassaJobsService] audit erro:", err?.message || err);
  });
}

class ModeloMassaJobsService {
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
    if (!job || !canAccessJob(job, accountKey)) return null;
    const { auditContext, creditReservation, ...publicJob } = job;
    return attachJobContract(attachJobReview({ ...publicJob }, {
          basePath: "/api/modelo-massa/jobs",
          hasCsv: Array.isArray(job.results),
        }), { module: "modelo-massa" });
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
      void settleCredits(job.creditReservation, { release: true });
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
    targetModel = "",
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
      throw new Error("Nenhum anúncio informado para o job de modelo em massa.");
    }

    if (!String(targetModel || "").trim()) {
      throw new Error("Informe o valor do campo modelo.");
    }

    const creditReservation = await reserveCredits({
      mlCreds,
      operationKey: "mass-model.apply",
      units: ids.length,
    });

    const id = makeId();
    const job = {
      id,
      kind: "modelo_massa",
      title: `${dryRun ? "Simular" : "Aplicar"} Modelo - ${ids.length} item(ns)`,
      state: "aguardando",
      progress: 0,
      total: ids.length,
      processed: 0,
      applied: 0,
      manual: 0,
      skipped: 0,
      errors: 0,
      dry_run: !!dryRun,
      target_model: String(targetModel).trim(),
      results: [],
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
        const state = await ModeloMassaService.prepareState(mlCreds);
        await auditModeloEvent(job, "model_mass_job_started", "success", {
          total_items: ids.length,
          sample_ids: ids.slice(0, 20),
          target_model: job.target_model,
          dry_run: !!dryRun,
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
            result = await ModeloMassaService.applyModelForItem(state, itemId, {
              target_model: targetModel,
              dry_run: !!dryRun,
            });
          } catch (error) {
            result = {
              id: itemId,
              status: "error",
              reason: error?.message || "Erro inesperado na execução do job.",
            };
          }

          job.results.push(result);
          job.processed += 1;

          await auditModeloEvent(
            job,
            "model_mass_item_processed",
            result.status === "applied" || result.status === "dry_run"
              ? "success"
              : result.status === "manual" || result.status === "skipped"
                ? "warn"
                : "error",
            {
              mlb_id: itemId,
              item_id: itemId,
              item_index: job.processed,
              total_items: job.total,
              item_status: result.status,
              listing_type: result.listing_type || null,
              field: "MODEL",
              previous_value: result.current_model || null,
              requested_value: result.target_model || job.target_model,
              applied_value:
                result.status === "applied" ? result.target_model || job.target_model : null,
              retry_removed_attributes: result.retry_removed_attributes || null,
              user_product_conflict_id: result.user_product_conflict_id || null,
              recommended_action: result.recommended_action || null,
              ml_body: result.response || result.details || null,
              message: safeText(result.reason || result.message || ""),
            },
          );

          if (result.status === "applied") job.applied += 1;
          else if (result.status === "manual") job.manual += 1;
          else if (result.status === "skipped" || result.status === "dry_run") job.skipped += 1;
          else if (result.status === "error") job.errors += 1;

          job.progress = Math.round((job.processed / job.total) * 100);
          job.updated_at = nowISO();
          JOBS.set(id, job);
        }

        job.state = `concluído: ${job.applied} aplicados, ${job.manual} manuais, ${job.errors} erros`;
        job.progress = 100;
        job.completed = true;
        job.updated_at = nowISO();
        JOBS.set(id, job);
        await settleCredits(job.creditReservation, { release: false });
        await auditModeloEvent(job, "model_mass_job_completed", job.errors > 0 ? "warn" : "success", {
          total_items: job.total,
          processed: job.processed,
          applied: job.applied,
          manual: job.manual,
          skipped: job.skipped,
          errors: job.errors,
          target_model: job.target_model,
          dry_run: !!dryRun,
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
        await auditModeloEvent(job, "model_mass_job_failed", "error", {
          total_items: job.total,
          processed: job.processed,
          applied: job.applied,
          manual: job.manual,
          skipped: job.skipped,
          errors: job.errors,
          target_model: job.target_model,
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
