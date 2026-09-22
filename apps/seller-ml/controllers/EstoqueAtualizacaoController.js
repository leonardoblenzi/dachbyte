"use strict";

const queueService = require("../services/estoqueAtualizacaoQueueService");
const {
  getRequestIp,
  getRequestUserAgent,
} = require("../services/authAuditService");

function pickAccessToken(req) {
  const token = req?.ml?.accessToken;
  if (!token) {
    const error = new Error("Token ML ausente em req.ml.accessToken.");
    error.statusCode = 401;
    throw error;
  }
  return token;
}

function accountContext(res) {
  return {
    accountKey: res.locals?.accountKey || res.locals?.mlCreds?.meli_conta_id || null,
    accountLabel: res.locals?.accountLabel || null,
    mlCreds: res.locals?.mlCreds || {},
  };
}

function auditContext(req, res) {
  return {
    userId: Number(req.user?.uid || req.user?.id || req.user?.usuario_id) || null,
    email: req.user?.email || null,
    ip: getRequestIp(req),
    userAgent: getRequestUserAgent(req),
    accountKey: res.locals?.accountKey || null,
    accountLabel: res.locals?.accountLabel || null,
    meli_conta_id: res.locals?.mlCreds?.meli_conta_id || null,
  };
}

async function enqueue(req, res) {
  try {
    const accessToken = pickAccessToken(req);
    const ctx = accountContext(res);
    if (String(process.env.STOCK_UPDATE_WEB_WORKER_FALLBACK || "").trim() === "1") {
      queueService.initWorker?.();
    }
    const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
    const jobId = await queueService.enqueueStockUpdateJob({
      accessToken,
      mlCreds: ctx.mlCreds,
      accountKey: ctx.accountKey,
      accountLabel: ctx.accountLabel,
      changes,
      auditContext: auditContext(req, res),
    });
    res.json({
      success: true,
      job_id: jobId,
      process_id: jobId,
      total: changes.length,
      message: "Atualizacao de estoque enviada para o worker.",
    });
  } catch (error) {
    res.status(error.statusCode || error.status || 400).json({
      success: false,
      error: error.message || "Falha ao iniciar atualizacao de estoque.",
      details: error.details || null,
    });
  }
}

async function listJobs(_req, res) {
  try {
    const ctx = accountContext(res);
    const jobs = await queueService.listStockUpdateJobs(30, { accountKey: ctx.accountKey });
    res.json({ success: true, jobs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || "Falha ao listar jobs de estoque." });
  }
}

async function detailJob(req, res) {
  try {
    const ctx = accountContext(res);
    const job = await queueService.getStockUpdateJobDetail(req.params.id, { accountKey: ctx.accountKey });
    if (!job) return res.status(404).json({ success: false, error: "Job nao encontrado." });
    res.json({ success: true, job });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || "Falha ao detalhar job de estoque." });
  }
}

async function downloadJob(req, res) {
  try {
    const ctx = accountContext(res);
    const file = await queueService.getStockUpdateJobCsv(req.params.id, { accountKey: ctx.accountKey });
    if (!file?.csv) return res.status(404).json({ success: false, error: "CSV nao encontrado." });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.send(file.csv);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || "Falha ao baixar CSV do estoque." });
  }
}

async function cancelJob(req, res) {
  try {
    const ctx = accountContext(res);
    const result = await queueService.cancelStockUpdateJob(req.params.id, { accountKey: ctx.accountKey });
    if (!result) return res.status(404).json({ success: false, error: "Job nao encontrado." });
    if (!result.ok) return res.status(409).json({ success: false, error: result.error, status: result.status });
    res.json({ success: true, status: result.status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || "Falha ao cancelar job de estoque." });
  }
}

async function retryErrors(req, res) {
  try {
    const ctx = accountContext(res);
    const result = await queueService.retryFailedStockJob(req.params.id, {
      accountKey: ctx.accountKey,
      auditContext: auditContext(req, res),
    });
    if (!result) return res.status(404).json({ success: false, error: "Job nao encontrado." });
    res.json({
      success: true,
      job_id: result.job_id,
      process_id: result.job_id,
      total: result.rows,
      message: "Nova tentativa criada somente para os erros seguros para reenvio.",
    });
  } catch (error) {
    res.status(error.statusCode || error.status || 400).json({
      success: false,
      error: error.message || "Falha ao criar nova tentativa.",
    });
  }
}

module.exports = {
  enqueue,
  listJobs,
  detailJob,
  downloadJob,
  cancelJob,
  retryErrors,
};
