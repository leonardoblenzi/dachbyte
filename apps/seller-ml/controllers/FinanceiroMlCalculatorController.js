"use strict";

const FinanceiroMlCalculatorService = require("../services/financeiroMlCalculatorService");

function context(req, res) {
  return {
    mlCreds: res.locals?.mlCreds || {},
    accountKey: res.locals?.accountKey || null,
    accountLabel: res.locals?.accountLabel || null,
    userId: Number(req.user?.uid || req.user?.id || req.user?.usuario_id) || null,
  };
}

function handleError(res, error, fallback) {
  const status = Number(error?.status || error?.statusCode);
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    success: false,
    error: error?.message || fallback || "Falha ao processar a calculadora.",
    details: error?.payload || error?.details || null,
  });
}

module.exports = {
  async lookup(req, res) {
    try {
      return res.json(await FinanceiroMlCalculatorService.lookup(req.query || {}, context(req, res)));
    } catch (error) {
      return handleError(res, error, "Falha ao carregar anúncio para a calculadora.");
    }
  },

  async categories(req, res) {
    try {
      return res.json(await FinanceiroMlCalculatorService.categories(req.query || {}, context(req, res)));
    } catch (error) {
      return handleError(res, error, "Falha ao buscar categorias para a calculadora.");
    }
  },

  async calculate(req, res) {
    try {
      return res.json(await FinanceiroMlCalculatorService.calculate(req.body || {}, context(req, res)));
    } catch (error) {
      return handleError(res, error, "Falha ao calcular margem e preço.");
    }
  },
};

