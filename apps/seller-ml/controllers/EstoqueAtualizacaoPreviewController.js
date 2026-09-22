"use strict";

const estoquePreviewService = require("../services/estoqueAtualizacaoPreviewService");

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

async function loadRows(req, res) {
  try {
    const accessToken = pickAccessToken(req);
    const ctx = accountContext(res);
    const payload = await estoquePreviewService.loadStockRows({
      accessToken,
      mlCreds: ctx.mlCreds,
      source: req.body?.source || "active",
      query: req.body?.query || req.body?.items || "",
      maxItems: req.body?.max_items ?? req.body?.maxItems ?? null,
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({
      success: false,
      error: error.message || "Falha ao carregar anuncios para atualizacao de estoque.",
      details: error.details || null,
    });
  }
}

async function preview(req, res) {
  try {
    const accessToken = pickAccessToken(req);
    const ctx = accountContext(res);
    const payload = await estoquePreviewService.previewStockChanges({
      accessToken,
      mlCreds: ctx.mlCreds,
      changes: req.body?.changes || [],
    });
    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({
      success: false,
      error: error.message || "Falha ao revisar alteracoes de estoque.",
      details: error.details || null,
    });
  }
}

module.exports = {
  loadRows,
  preview,
};
