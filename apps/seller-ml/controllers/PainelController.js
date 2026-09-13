"use strict";

const PainelService = require("../services/painelService");

class PainelController {
  static async overview(req, res) {
    try {
      const data = await PainelService.obterOverview(
        { preset: req.query?.preset || "today" },
        {
          accessToken: req?.ml?.accessToken || res.locals?.accessToken || null,
          mlCreds: res.locals?.mlCreds || {},
          accountKey: res.locals?.accountKey || null,
          accountLabel: res.locals?.accountLabel || null,
          forceRefresh:
            String(req.query?.refresh || "").trim() === "1" ||
            String(req.query?.force || "").trim() === "1",
          logger: console,
        },
      );

      return res.json(data);
    } catch (error) {
      const status = error?.statusCode || error?.httpStatus || 500;
      return res.status(status).json({
        success: false,
        error: error?.message || "Falha ao consolidar o Painel.",
      });
    }
  }

  static async financeSummary(req, res) {
    try {
      const data = await PainelService.obterFinanceiroRapido(
        { preset: req.query?.preset || "today" },
        {
          accessToken: req?.ml?.accessToken || res.locals?.accessToken || null,
          mlCreds: res.locals?.mlCreds || {},
          accountKey: res.locals?.accountKey || null,
          accountLabel: res.locals?.accountLabel || null,
          forceRefresh:
            String(req.query?.refresh || "").trim() === "1" ||
            String(req.query?.force || "").trim() === "1",
          logger: console,
        },
      );
      return res.json(data);
    } catch (error) {
      const status = error?.statusCode || error?.httpStatus || 500;
      return res.status(status).json({
        success: false,
        error: error?.message || "Falha ao consolidar o resumo financeiro do Painel.",
      });
    }
  }

  static async inactivity(req, res) {
    try {
      const data = await PainelService.obterInatividade({
        accessToken: req?.ml?.accessToken || res.locals?.accessToken || null,
        accountKey: res.locals?.accountKey || null,
        accountLabel: res.locals?.accountLabel || null,
        forceRefresh:
          String(req.query?.refresh || "").trim() === "1" ||
          String(req.query?.force || "").trim() === "1",
        logger: console,
      });

      return res.json(data);
    } catch (error) {
      const status = error?.statusCode || error?.httpStatus || 500;
      return res.status(status).json({
        success: false,
        error: error?.message || "Falha ao consolidar a inatividade do Painel.",
      });
    }
  }
}

module.exports = PainelController;
