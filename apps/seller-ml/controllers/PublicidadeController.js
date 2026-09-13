// controllers/PublicidadeController.js
const ProductAdsService = require("../services/productAdsService");

/**
 * Helper para mapear o resultado do service -> HTTP response
 */
function sendFromResult(res, result, context) {
  if (!result) {
    return res.status(500).json({
      success: false,
      error: `Retorno vazio do service em ${context}`,
    });
  }

  // Sucesso direto
  if (result.success) {
    return res.status(200).json(result);
  }

  const payload = {
    success: false,
    error: result.error || "Erro desconhecido",
    code: result.code || null,
  };

  // Mapeamento básico por código (vindo do ProductAdsService)
  switch (result.code) {
    case "PERMISSION_DENIED":
      return res.status(403).json(payload);

    case "NO_ADVERTISER":
      return res.status(404).json(payload);

    case "CAMPAIGNS_ERROR":
    case "ITEMS_ERROR":
    case "METRICS_ERROR":
    case "ML_NOT_FOUND":
    case "WIZARD_ITEMS_ERROR":
    case "CAMPAIGN_CREATE_ERROR":
    case "CAMPAIGN_UPDATE_ERROR":
    case "ITEM_REMOVE_ERROR":
      return res.status(502).json(payload);

    case "INVALID_INPUT":
    case "NO_ITEMS_SELECTED":
      return res.status(400).json(payload);

    default:
      return res.status(400).json(payload);
  }
}

function sendCsv(res, { csv, filename }) {
  // BOM UTF-8 para Excel/PT-BR abrir acentos corretamente
  const body = `\ufeff${csv || ""}`;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename || "export.csv"}"`
  );
  return res.send(body);
}

module.exports = {
  // ==========================================
  // RESUMO CONSOLIDADO DE CAMPANHAS
  // GET /api/publicidade/product-ads/summary
  // ==========================================
  async obterResumoCampanhas(req, res) {
    try {
      const { date_from, date_to } = req.query;
      const { mlCreds, accountKey } = res.locals;

      const result = await ProductAdsService.obterResumoCampanhas(
        { date_from, date_to },
        { mlCreds, accountKey }
      );

      return sendFromResult(res, result, "obterResumoCampanhas");
    } catch (err) {
      console.error("Erro em obterResumoCampanhas:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Erro interno em obterResumoCampanhas",
      });
    }
  },

  // ==========================================
  // LISTAR CAMPANHAS
  // GET /api/publicidade/product-ads/campaigns
  // ==========================================
  async listarCampanhas(req, res) {
    try {
      const { date_from, date_to } = req.query;
      const { mlCreds, accountKey } = res.locals;

      const result = await ProductAdsService.listarCampanhas(
        { date_from, date_to },
        { mlCreds, accountKey }
      );

      return sendFromResult(res, result, "listarCampanhas");
    } catch (err) {
      console.error("Erro em listarCampanhas:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Erro interno em listarCampanhas",
      });
    }
  },

  async obterCampanha(req, res) {
    try {
      const { id } = req.params;
      const { mlCreds, accountKey } = res.locals;

      const result = await ProductAdsService.obterCampanha(id, {
        mlCreds,
        accountKey,
      });

      return sendFromResult(res, result, "obterCampanha");
    } catch (err) {
      console.error("Erro em obterCampanha:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Erro interno em obterCampanha",
      });
    }
  },

  async atualizarCampanha(req, res) {
    try {
      const { id } = req.params;
      const payload = req.body || {};
      const { mlCreds, accountKey } = res.locals;

      const result = await ProductAdsService.atualizarCampanha(id, payload, {
        mlCreds,
        accountKey,
      });

      return sendFromResult(res, result, "atualizarCampanha");
    } catch (err) {
      console.error("Erro em atualizarCampanha:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Erro interno em atualizarCampanha",
      });
    }
  },

  // ==========================================
  // LISTAR AD GROUPS / ANUNCIOS PATROCINADOS
  // GET /api/publicidade/product-ads/ad-groups
  // ==========================================
  async listarAdGroups(req, res) {
    try {
      const { date_from, date_to, campaign_id, status, query, page, limit, all } = req.query;
      const { mlCreds, accountKey } = res.locals;

      const result = await ProductAdsService.listarAdGroups(
        { date_from, date_to, campaign_id, status, query, page, limit, all },
        { mlCreds, accountKey }
      );

      return sendFromResult(res, result, "listarAdGroups");
    } catch (err) {
      console.error("Erro em listarAdGroups:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Erro interno em listarAdGroups",
      });
    }
  },

  // ==========================================
  // LISTAR ITENS DE UMA CAMPANHA
  // GET /api/publicidade/product-ads/campaigns/:id/items
  // ==========================================
  async listarItensCampanha(req, res) {
    try {
      const { id } = req.params;
      const { date_from, date_to } = req.query;
      const { mlCreds, accountKey } = res.locals;

      const result = await ProductAdsService.listarItensCampanha(
        id,
        { date_from, date_to },
        { mlCreds, accountKey }
      );

      return sendFromResult(res, result, "listarItensCampanha");
    } catch (err) {
      console.error("Erro em listarItensCampanha:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Erro interno em listarItensCampanha",
      });
    }
  },

  async listarItensDisponiveisCampanha(req, res) {
    try {
      const { id } = req.params;
      const { query, status, page, limit } = req.query;
      const { mlCreds, accountKey } = res.locals;

      const result = await ProductAdsService.listarItensDisponiveisCampanha(
        id,
        { query, status, page, limit },
        { mlCreds, accountKey }
      );

      return sendFromResult(res, result, "listarItensDisponiveisCampanha");
    } catch (err) {
      console.error("Erro em listarItensDisponiveisCampanha:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Erro interno em listarItensDisponiveisCampanha",
      });
    }
  },

  async adicionarItensCampanha(req, res) {
    try {
      const { id } = req.params;
      const payload = req.body || {};
      const { mlCreds, accountKey } = res.locals;

      const result = await ProductAdsService.adicionarItensCampanha(id, payload, {
        mlCreds,
        accountKey,
      });

      return sendFromResult(res, result, "adicionarItensCampanha");
    } catch (err) {
      console.error("Erro em adicionarItensCampanha:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Erro interno em adicionarItensCampanha",
      });
    }
  },

  async removerItemCampanha(req, res) {
    try {
      const { id, itemId } = req.params;
      const { mlCreds, accountKey } = res.locals;

      const result = await ProductAdsService.removerItemCampanha(id, itemId, {
        mlCreds,
        accountKey,
      });

      return sendFromResult(res, result, "removerItemCampanha");
    } catch (err) {
      console.error("Erro em removerItemCampanha:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Erro interno em removerItemCampanha",
      });
    }
  },

  async atualizarItemCampanha(req, res) {
    try {
      const { id, itemId } = req.params;
      const payload = req.body || {};
      const { mlCreds, accountKey } = res.locals;

      const result = await ProductAdsService.atualizarItemCampanha(
        id,
        itemId,
        payload,
        { mlCreds, accountKey }
      );

      return sendFromResult(res, result, "atualizarItemCampanha");
    } catch (err) {
      console.error("Erro em atualizarItemCampanha:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Erro interno em atualizarItemCampanha",
      });
    }
  },

  // ==========================================
  // EXPORTAR CSV (NOVO)
  // GET /api/publicidade/product-ads/campaigns/:id/items/export.csv
  // -> CSV com: mlb, campanha
  // ==========================================
  async exportarItensCampanhaCsv(req, res) {
    try {
      const { id } = req.params;
      const { date_from, date_to } = req.query;
      const { mlCreds, accountKey } = res.locals;

      const result = await ProductAdsService.exportarItensCampanhaCsv(
        id,
        { date_from, date_to },
        { mlCreds, accountKey }
      );

      if (!result || !result.success) {
        return sendFromResult(res, result, "exportarItensCampanhaCsv");
      }

      const filename = result.filename || `product-ads-campanha-${id}.csv`;

      return sendCsv(res, { csv: result.csv, filename });
    } catch (err) {
      console.error("Erro em exportarItensCampanhaCsv:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Erro interno em exportarItensCampanhaCsv",
      });
    }
  },

  // ==========================================
  // EXPORTAR CSV (LEGADO / compat)
  // GET /api/publicidade/product-ads/campaigns/:id/export
  // -> aponta para o mesmo export do novo
  // ==========================================
  async exportarItensCampanha(req, res) {
    // Reutiliza exatamente o mesmo handler
    return module.exports.exportarItensCampanhaCsv(req, res);
  },

  // ==========================================
  // MÉTRICAS DIÁRIAS (GRÁFICO)
  // GET /api/publicidade/product-ads/metrics/daily
  // ==========================================
  async metricasDiarias(req, res) {
    try {
      const { date_from, date_to } = req.query;
      const { mlCreds, accountKey } = res.locals;

      const result = await ProductAdsService.metricasDiarias(
        { date_from, date_to },
        { mlCreds, accountKey }
      );

      return sendFromResult(res, result, "metricasDiarias");
    } catch (err) {
      console.error("Erro em metricasDiarias:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Erro interno em metricasDiarias",
      });
    }
  },

  async metricasDiariasCampanha(req, res) {
    try {
      const { id } = req.params;
      const { date_from, date_to } = req.query;
      const { mlCreds, accountKey } = res.locals;

      const result = await ProductAdsService.metricasDiariasCampanha(
        id,
        { date_from, date_to },
        { mlCreds, accountKey }
      );

      return sendFromResult(res, result, "metricasDiariasCampanha");
    } catch (err) {
      console.error("Erro em metricasDiariasCampanha:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Erro interno em metricasDiariasCampanha",
      });
    }
  },

  // ==========================================
  // WIZARD - PASSO 1
  // GET /api/publicidade/product-ads/campaign-wizard/items
  // ==========================================
  async listarItensWizardCriacao(req, res) {
    try {
      const { query, status, page, limit } = req.query;
      const { mlCreds, accountKey } = res.locals;

      const result = await ProductAdsService.listarItensWizardCriacao(
        { query, status, page, limit },
        { mlCreds, accountKey }
      );

      return sendFromResult(res, result, "listarItensWizardCriacao");
    } catch (err) {
      console.error("Erro em listarItensWizardCriacao:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Erro interno em listarItensWizardCriacao",
      });
    }
  },

  // ==========================================
  // WIZARD - PASSO 2
  // POST /api/publicidade/product-ads/campaigns
  // ==========================================
  async criarCampanhaComItens(req, res) {
    try {
      const { mlCreds, accountKey } = res.locals;
      const payload = req.body || {};

      const result = await ProductAdsService.criarCampanhaComItens(
        payload,
        { mlCreds, accountKey }
      );

      return sendFromResult(res, result, "criarCampanhaComItens");
    } catch (err) {
      console.error("Erro em criarCampanhaComItens:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Erro interno em criarCampanhaComItens",
      });
    }
  },
};
