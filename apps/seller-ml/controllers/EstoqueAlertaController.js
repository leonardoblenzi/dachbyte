"use strict";

const estoqueService = require("../services/estoqueAlertaService");
const estoqueQueue = require("../services/estoqueAlertaQueueService");

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

async function analyze(req, res) {
  try {
    const accessToken = pickAccessToken(req);
    const ctx = accountContext(res);
    const payload = await estoqueService.analyzeStock({
      accessToken,
      mlCreds: ctx.mlCreds,
      accountKey: ctx.accountKey,
      accountLabel: ctx.accountLabel,
      source: req.body?.source || "manual",
      query: req.body?.query || req.body?.items || "",
      maxItems: req.body?.max_items ?? req.body?.maxItems ?? null,
      periodDays: req.body?.period_days ?? req.body?.periodDays ?? 30,
      customFrom: req.body?.custom_from ?? req.body?.customFrom ?? null,
      customTo: req.body?.custom_to ?? req.body?.customTo ?? null,
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({
      success: false,
      error: error.message || "Falha ao analisar estoque.",
      details: error.details || null,
    });
  }
}

async function enqueue(req, res) {
  try {
    const accessToken = pickAccessToken(req);
    const ctx = accountContext(res);
    if (String(process.env.STOCK_ALERT_WEB_WORKER_FALLBACK || "").trim() === "1") {
      estoqueQueue.initWorker?.();
    }
    const processId = await estoqueQueue.enqueueStockJob({
      accessToken,
      mlCreds: ctx.mlCreds,
      accountKey: ctx.accountKey,
      accountLabel: ctx.accountLabel,
      source: req.body?.source || "sold_period",
      query: req.body?.query || req.body?.items || "",
      maxItems: req.body?.max_items ?? req.body?.maxItems ?? null,
      periodDays: req.body?.period_days ?? req.body?.periodDays ?? 30,
      customFrom: req.body?.custom_from ?? req.body?.customFrom ?? null,
      customTo: req.body?.custom_to ?? req.body?.customTo ?? null,
    });
    res.json({
      success: true,
      process_id: processId,
      job_id: processId,
      message: "Analise de estoque enviada para o painel de processos.",
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao iniciar job." });
  }
}

async function list(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await estoqueService.listStored({
      accountKey: ctx.accountKey,
      limit: req.query?.limit || 250,
    });
    res.json(payload);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || "Falha ao listar monitoramento." });
  }
}

async function riskKpi(_req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await estoqueService.riskKpi({ accountKey: ctx.accountKey, limit: 5 });
    res.json(payload);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || "Falha ao carregar KPI de estoque." });
  }
}

async function markPurchase(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await estoqueService.markPurchase({
      accountKey: ctx.accountKey,
      mlb: req.params?.mlb || req.body?.mlb || req.body?.mlb_id,
      expectedArrivalDate: req.body?.expected_arrival_date || req.body?.expectedArrivalDate,
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao marcar compra." });
  }
}

async function clearPurchase(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await estoqueService.clearPurchase({
      accountKey: ctx.accountKey,
      mlb: req.params?.mlb || req.body?.mlb || req.body?.mlb_id,
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao limpar status." });
  }
}

async function removeWatchItem(req, res) {
  try {
    const ctx = accountContext(res);
    const payload = await estoqueService.removeWatchItem({
      accountKey: ctx.accountKey,
      mlb: req.params?.mlb || req.body?.mlb || req.body?.mlb_id,
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, error: error.message || "Falha ao remover monitorado." });
  }
}

async function listJobs(_req, res) {
  try {
    const ctx = accountContext(res);
    const jobs = await estoqueQueue.listStockJobs(30, { accountKey: ctx.accountKey });
    res.json({ success: true, jobs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || "Falha ao listar jobs." });
  }
}

async function detailJob(req, res) {
  try {
    const ctx = accountContext(res);
    const job = await estoqueQueue.getStockJobDetail(req.params.id, { accountKey: ctx.accountKey });
    if (!job) return res.status(404).json({ success: false, error: "Job nao encontrado." });
    res.json({ success: true, job });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || "Falha ao detalhar job." });
  }
}

async function downloadJob(req, res) {
  try {
    const ctx = accountContext(res);
    const file = await estoqueQueue.getStockJobCsv(req.params.id, { accountKey: ctx.accountKey });
    if (!file?.csv) return res.status(404).json({ success: false, error: "CSV nao encontrado." });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.send(file.csv);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || "Falha ao baixar CSV." });
  }
}

async function cancelJob(req, res) {
  try {
    const ctx = accountContext(res);
    const result = await estoqueQueue.cancelStockJob(req.params.id, { accountKey: ctx.accountKey });
    if (!result) return res.status(404).json({ success: false, error: "Job nao encontrado." });
    if (!result.ok) return res.status(409).json({ success: false, error: result.error, status: result.status });
    res.json({ success: true, status: result.status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || "Falha ao cancelar job." });
  }
}

module.exports = {
  analyze,
  enqueue,
  list,
  riskKpi,
  markPurchase,
  clearPurchase,
  removeWatchItem,
  listJobs,
  detailJob,
  downloadJob,
  cancelJob,
};
