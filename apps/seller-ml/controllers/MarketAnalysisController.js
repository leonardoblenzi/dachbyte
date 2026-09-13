"use strict";

const MarketAnalysisService = require("../services/marketAnalysisService");

function normalizeStatus(error) {
  const status = Number(error?.status || 400);
  return status >= 400 && status < 600 ? status : 400;
}

function buildUpstream(error) {
  const payload = error?.payload || {};
  const upstream = {
    status: Number.isFinite(Number(error?.status)) ? Number(error.status) : null,
    code: error?.upstreamCode || payload?.code || payload?.error || null,
    blocked_by: error?.blockedBy || payload?.blocked_by || null,
    endpoint: error?.endpoint || null,
  };
  return Object.values(upstream).some((value) => value !== null && value !== "") ? upstream : null;
}

function friendlyMessage(error, fallback) {
  const status = Number(error?.status || 0);
  if (status === 401) return "A autorização da conta Mercado Livre expirou ou não é válida para este recurso.";
  if (status === 403) return "O Mercado Livre recusou o acesso a um dos recursos usados nesta análise.";
  if (status === 429) return "O Mercado Livre limitou temporariamente o volume de consultas. Tente novamente em instantes.";
  return error?.message || fallback;
}

function sendError(res, error, fallback, operation) {
  const status = normalizeStatus(error);
  const upstream = buildUpstream(error);
  console.error("[market-analysis] request failed", {
    operation,
    status,
    message: error?.message || fallback,
    upstream,
  });

  return res.status(status).json({
    success: false,
    error: friendlyMessage(error, fallback),
    code: error?.code || "MARKET_ANALYSIS_ERROR",
    upstream,
  });
}

class MarketAnalysisController {
  static async search(req, res) {
    try {
      const payload = await MarketAnalysisService.search({
        mlCreds: res.locals?.mlCreds || {},
        q: req.query?.q,
      });
      return res.json(payload);
    } catch (error) {
      return sendError(res, error, "Erro ao buscar oportunidades de mercado.", "search");
    }
  }

  static async category(req, res) {
    try {
      const payload = await MarketAnalysisService.analyzeCategory({
        mlCreds: res.locals?.mlCreds || {},
        categoryId: req.params?.categoryId,
        sampleLimit: req.query?.sample_limit || req.query?.limit,
        q: req.query?.q,
        domainId: req.query?.domain_id,
      });
      return res.json(payload);
    } catch (error) {
      return sendError(res, error, "Erro ao analisar categoria.", "category");
    }
  }

  static async categorySuggestions(req, res) {
    try {
      const payload = await MarketAnalysisService.categorySuggestions({
        mlCreds: res.locals?.mlCreds || {},
        q: req.query?.q,
      });
      return res.json(payload);
    } catch (error) {
      return sendError(res, error, "Erro ao buscar sugestões de categorias.", "category-suggestions");
    }
  }

  static async keywords(req, res) {
    try {
      const payload = await MarketAnalysisService.keywords({
        mlCreds: res.locals?.mlCreds || {},
        q: req.query?.q,
      });
      return res.json(payload);
    } catch (error) {
      return sendError(res, error, "Erro ao analisar palavras-chave.", "keywords");
    }
  }

  static async categoryTrends(req, res) {
    try {
      const payload = await MarketAnalysisService.categoryTrends({
        mlCreds: res.locals?.mlCreds || {},
        categoryId: req.params?.categoryId,
      });
      return res.json(payload);
    } catch (error) {
      return sendError(res, error, "Erro ao carregar tendências da categoria.", "category-trends");
    }
  }

  static async generalTrends(_req, res) {
    try {
      const payload = await MarketAnalysisService.generalTrends({
        mlCreds: res.locals?.mlCreds || {},
      });
      return res.json(payload);
    } catch (error) {
      return sendError(res, error, "Erro ao carregar tendências gerais.", "general-trends");
    }
  }
}

module.exports = MarketAnalysisController;
