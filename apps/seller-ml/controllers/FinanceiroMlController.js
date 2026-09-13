"use strict";

const FinanceiroMlService = require("../services/financeiroMlService");
const FinanceiroMlSkuCatalogSyncService = require("../services/financeiroMlSkuCatalogSyncService");
const MarketingMlService = require("../services/marketingMlService");

function context(req, res) {
  return {
    mlCreds: res.locals?.mlCreds || {},
    accountKey: res.locals?.accountKey || null,
    userId: FinanceiroMlService.getUserId(req.user),
  };
}

function handleError(res, error, fallback) {
  const status = Number(error?.status);
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    success: false,
    error: error?.message || fallback || "Falha ao processar financeiro ML.",
    details: error?.payload || null,
  });
}

module.exports = {
  async listCosts(req, res) {
    try {
      return res.json(await FinanceiroMlService.listCosts(req.query || {}, context(req, res)));
    } catch (error) {
      return handleError(res, error, "Falha ao listar custos por SKU.");
    }
  },

  async syncCostsCatalog(req, res) {
    try {
      return res.json(
        await FinanceiroMlSkuCatalogSyncService.enqueue({
          ...context(req, res),
          userId: FinanceiroMlService.getUserId(req.user),
        }),
      );
    } catch (error) {
      return handleError(res, error, "Falha ao iniciar sincronizacao de SKUs.");
    }
  },

  async syncCostsCatalogStatus(req, res) {
    try {
      const job = await FinanceiroMlSkuCatalogSyncService.status(req.params.jobId, context(req, res));
      if (!job) return res.status(404).json({ success: false, error: "Job nao encontrado." });
      return res.json({ success: true, job });
    } catch (error) {
      return handleError(res, error, "Falha ao consultar sincronizacao de SKUs.");
    }
  },

  async costTimeline(req, res) {
    try {
      return res.json(
        await FinanceiroMlService.costTimeline(
          {
            ...req.query,
            sku: req.params.sku,
          },
          context(req, res),
        ),
      );
    } catch (error) {
      return handleError(res, error, "Falha ao carregar historico do SKU.");
    }
  },

  async saveCost(req, res) {
    try {
      const result = await FinanceiroMlService.saveCost(
        {
          sku: req.params.sku,
          cost: req.body?.cost ?? req.body?.custo_produto_unitario,
          userId: FinanceiroMlService.getUserId(req.user),
        },
        context(req, res),
      );
      return res.json(result);
    } catch (error) {
      return handleError(res, error, "Falha ao salvar custo por SKU.");
    }
  },

  async importCosts(req, res) {
    try {
      const result = await FinanceiroMlService.importCosts(
        {
          filename: req.body?.filename,
          content_base64: req.body?.content_base64,
          userId: FinanceiroMlService.getUserId(req.user),
        },
        context(req, res),
      );
      return res.json(result);
    } catch (error) {
      return handleError(res, error, "Falha ao importar custos.");
    }
  },

  async exportCosts(req, res) {
    try {
      const file = await FinanceiroMlService.exportCosts(req.query || {}, context(req, res));
      res.setHeader("Content-Type", file.contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
      return res.send(file.buffer);
    } catch (error) {
      return handleError(res, error, "Falha ao exportar custos.");
    }
  },

  async getTax(req, res) {
    try {
      return res.json(await FinanceiroMlService.getTax(req.query || {}, context(req, res)));
    } catch (error) {
      return handleError(res, error, "Falha ao carregar aliquota.");
    }
  },

  async saveTax(req, res) {
    try {
      return res.json(
        await FinanceiroMlService.saveTax(
          {
            aliquota: req.body?.aliquota ?? req.body?.taxRate,
            userId: FinanceiroMlService.getUserId(req.user),
          },
          context(req, res),
        ),
      );
    } catch (error) {
      return handleError(res, error, "Falha ao salvar aliquota.");
    }
  },

  async listMargin(req, res) {
    try {
      return res.json(await FinanceiroMlService.listMargin(req.query || {}, context(req, res)));
    } catch (error) {
      return handleError(res, error, "Falha ao carregar margem de venda.");
    }
  },

  async marketingSummary(req, res) {
    try {
      return res.json(await MarketingMlService.getPeriodSummary(req.query || {}, context(req, res)));
    } catch (error) {
      return handleError(res, error, "Falha ao carregar aquisicao e publicidade do periodo.");
    }
  },

  async exportMargin(req, res) {
    try {
      const file = await FinanceiroMlService.exportMargin(req.query || {}, context(req, res));
      res.setHeader("Content-Type", file.contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
      return res.send(file.buffer);
    } catch (error) {
      return handleError(res, error, "Falha ao exportar margem em XLSX.");
    }
  },
};
