"use strict";

const {
  updatePrazoProducao,
  consultPrazoProducao,
} = require("../services/prazoProducaoService");
const {
  enqueuePrazoJob,
  enqueuePrazoLookupActiveJob,
  getPrazoJobStatus,
  listPrazoJobs,
  getPrazoJobDetail,
  getPrazoJobCsv,
  cancelPrazoJob,
} = require("../services/prazoProducaoQueueService");
const { attachJobContract } = require("../services/jobContract");
const {
  getRequestIp,
  getRequestUserAgent,
  recordAuthEvent,
} = require("../services/authAuditService");

function buildAuditContext(req, res) {
  return {
    userId: Number(req.user?.uid || res.locals?.user?.uid || res.locals?.user?.id) || null,
    email: req.user?.email || res.locals?.user?.email || null,
    ip: getRequestIp(req),
    userAgent: getRequestUserAgent(req),
    accountKey: res.locals?.accountKey || null,
    accountLabel: res.locals?.accountLabel || res.locals?.accountKey || null,
    meli_conta_id: res.locals?.mlCreds?.meli_conta_id || null,
    route: req.originalUrl || req.path || null,
    method: req.method || null,
  };
}

function auditPrazo(req, res, evento, status, metadata = {}) {
  const context = buildAuditContext(req, res);
  return recordAuthEvent({
    userId: context.userId,
    email: context.email,
    evento,
    status,
    ip: context.ip,
    userAgent: context.userAgent,
    metadata: {
      accountKey: context.accountKey,
      accountLabel: context.accountLabel,
      meli_conta_id: context.meli_conta_id,
      route: context.route,
      method: context.method,
      action: "update_production_time",
      ...metadata,
    },
  }).catch((err) => {
    console.error("audit prazo producao erro:", err?.message || err);
  });
}

function pickAccessToken(req) {
  const t = req?.ml?.accessToken;
  if (!t) {
    const err = new Error("Token ML ausente em req.ml.accessToken.");
    err.statusCode = 401;
    throw err;
  }
  return t;
}

async function setPrazoProducaoSingle(req, res) {
  try {
    const accessToken = pickAccessToken(req);
    const { mlb_id, days } = req.body || {};

    const out = await updatePrazoProducao({
      accessToken,
      mlCreds: res.locals?.mlCreds || {},
      mlbId: mlb_id,
      days,
      verify: true,
    });

    await auditPrazo(req, res, "production_time_item_processed", "success", {
      mlb_id: out?.mlb_id || mlb_id,
      item_id: out?.mlb_id || mlb_id,
      requested_days: Number(days),
      previous_days: out?.manufacturing_before?.value_struct?.number ?? null,
      applied_days: out?.manufacturing_after?.value_struct?.number ?? null,
      previous_value: out?.manufacturing_before || null,
      applied_value: out?.manufacturing_after || null,
      ml_status: out?.put_result ? 200 : null,
      message: "Prazo de producao atualizado individualmente.",
    });

    res.json(out);
  } catch (e) {
    res.status(e.statusCode || 400).json({
      success: false,
      error: e.message || "Falha",
      details: e.details || null,
    });
  }
}

async function consultarPrazoProducao(req, res) {
  try {
    const accessToken = pickAccessToken(req);
    const payload = await consultPrazoProducao({
      accessToken,
      mlCreds: res.locals?.mlCreds || {},
      mlbIds: req.body?.mlb_ids || req.body?.item_ids || [],
    });

    res.json(payload);
  } catch (e) {
    res.status(e.statusCode || 400).json({
      success: false,
      error: e.message || "Falha ao consultar prazos",
      details: e.details || null,
    });
  }
}

async function consultarPrazoAtivosJob(req, res) {
  try {
    const accessToken = pickAccessToken(req);
    const maxItemsRaw = Number(req.body?.max_items ?? req.body?.maxItems ?? 0);
    const maxItems =
      Number.isFinite(maxItemsRaw) && maxItemsRaw > 0
        ? Math.trunc(maxItemsRaw)
        : null;

    const process_id = await enqueuePrazoLookupActiveJob({
      accessToken,
      mlCreds: res.locals?.mlCreds || {},
      maxItems,
      accountKey: res.locals?.accountKey || null,
      accountLabel: res.locals?.accountLabel || null,
      auditContext: buildAuditContext(req, res),
    });
    const contracted = attachJobContract({
      id: process_id,
      status: "aguardando",
      completed: false,
      progress: 0,
    }, { module: "prazo", kind: "lookup_active" });

    res.json({
      success: true,
      process_id,
      job_id: process_id,
      job_uid: contracted.job_uid,
      backend_job_id: contracted.backend_job_id,
      lifecycle_status: contracted.lifecycle_status,
      job_contract: contracted.job_contract,
      message: "Consulta de prazos dos anuncios ativos enviada para o painel.",
    });
  } catch (e) {
    res.status(e.statusCode || 400).json({
      success: false,
      error: e.message || "Falha ao consultar ativos",
      details: e.details || null,
    });
  }
}

async function setPrazoProducaoLote(req, res) {
  try {
    const accessToken = pickAccessToken(req);
    const { mlb_ids, days, delayMs } = req.body || {};

    if (!Array.isArray(mlb_ids) || mlb_ids.length === 0) {
      return res.status(400).json({ success: false, error: "mlb_ids vazio" });
    }

    const process_id = await enqueuePrazoJob({
      accessToken,
      mlCreds: res.locals?.mlCreds || {},
      mlb_ids,
      days,
      delayMs: delayMs ?? 250,
      accountKey: res.locals?.accountKey || null,
      accountLabel: res.locals?.accountLabel || null,
    });
    const contracted = attachJobContract({
      id: process_id,
      status: "aguardando",
      completed: false,
      progress: 0,
    }, { module: "prazo", kind: "update" });

    res.json({
      success: true,
      process_id,
      job_id: process_id,
      job_uid: contracted.job_uid,
      backend_job_id: contracted.backend_job_id,
      lifecycle_status: contracted.lifecycle_status,
      job_contract: contracted.job_contract,
    });
  } catch (e) {
    res.status(e.statusCode || 400).json({
      success: false,
      error: e.message || "Falha",
      details: e.details || null,
    });
  }
}

async function statusPrazoProducao(req, res) {
  try {
    const id = req.params.id;
    const st = await getPrazoJobStatus(id, {
      accountKey: res.locals?.accountKey || null,
    });
    if (!st) return res.status(404).json({ error: "processo não encontrado" });
    res.json(st);
  } catch (e) {
    res.status(500).json({ error: e.message || "Falha" });
  }
}

async function listJobsPrazoProducao(_req, res) {
  try {
    const jobs = await listPrazoJobs(25, {
      accountKey: res.locals?.accountKey || null,
    });
    res.json({ success: true, jobs });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message || "Falha" });
  }
}

async function detailJobPrazoProducao(req, res) {
  try {
    const job = await getPrazoJobDetail(req.params.id, {
      accountKey: res.locals?.accountKey || null,
    });
    if (!job) return res.status(404).json({ success: false, error: "job nao encontrado" });
    res.json({ success: true, job });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message || "Falha" });
  }
}

async function cancelJobPrazoProducao(req, res) {
  try {
    const result = await cancelPrazoJob(req.params.id, {
      accountKey: res.locals?.accountKey || null,
    });
    if (!result) return res.status(404).json({ success: false, error: "job nao encontrado" });
    if (!result.ok) return res.status(409).json({ success: false, error: result.error, status: result.status });
    const contracted = attachJobContract({
      id: req.params.id,
      status: result.status,
      completed: result.status === "cancelado",
    }, { module: "prazo" });
    res.json({ success: true, status: result.status, id: req.params.id, ...contracted });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message || "Falha" });
  }
}

async function downloadJobPrazoProducao(req, res) {
  try {
    const file = await getPrazoJobCsv(req.params.id, {
      accountKey: res.locals?.accountKey || null,
    });
    if (!file?.csv) {
      return res.status(404).json({ success: false, error: "CSV do job nao encontrado" });
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    return res.send(file.csv);
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || "Falha" });
  }
}

module.exports = {
  consultarPrazoProducao,
  consultarPrazoAtivosJob,
  setPrazoProducaoSingle,
  setPrazoProducaoLote,
  statusPrazoProducao,
  listJobsPrazoProducao,
  detailJobPrazoProducao,
  downloadJobPrazoProducao,
  cancelJobPrazoProducao,
};
