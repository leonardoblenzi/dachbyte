"use strict";

const ReputacaoService = require("../services/reputacaoService");

class ReputacaoController {
  static async overview(req, res) {
    try {
      const data = await ReputacaoService.obterVisaoGeral({
        page: req.query.page,
        pageSize: req.query.pageSize,
        limit: req.query.limit,
        offset: req.query.offset,
        forceRefresh: req.query.forceRefresh,
        mlCreds: res.locals?.mlCreds || {},
        accountKey: res.locals?.accountKey || null,
        logger: console,
      });

      return res.json({ success: true, ...data });
    } catch (error) {
      console.error("[ReputacaoController.overview]", error?.message || error);
      return res.status(500).json({
        success: false,
        error: error?.message || "Falha ao carregar reputacao",
      });
    }
  }
}

module.exports = ReputacaoController;
