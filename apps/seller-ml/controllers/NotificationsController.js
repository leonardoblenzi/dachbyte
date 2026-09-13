"use strict";

const NotificationsService = require("../services/notificationsService");

function getUserId(req) {
  const raw = req.user?.uid ?? req.user?.id ?? req.user?.user_id ?? null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function getAccountId(req, res) {
  const raw =
    res.locals?.mlCreds?.meli_conta_id ??
    res.locals?.account?.key ??
    res.locals?.accountKey ??
    null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function getCompanyId(res) {
  const raw = res.locals?.empresaId ?? res.locals?.account?.empresa_id ?? null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

class NotificationsController {
  static async list(req, res) {
    try {
      const payload = await NotificationsService.list({
        userId: getUserId(req),
        accountId: getAccountId(req, res),
      });

      const status = payload?.success === false ? 400 : 200;
      return res.status(status).json(payload);
    } catch (error) {
      console.error("Erro em NotificationsController.list:", error);
      return res.status(500).json({
        success: false,
        error: error?.message || "Falha ao carregar notificacoes.",
      });
    }
  }

  static async refresh(req, res) {
    try {
      const payload = await NotificationsService.refresh({
        userId: getUserId(req),
        companyId: getCompanyId(res),
        accountId: getAccountId(req, res),
        accountKey: res.locals?.accountKey || null,
        accountLabel: res.locals?.accountLabel || null,
        mlCreds: res.locals?.mlCreds || {},
        accessToken: req?.ml?.accessToken || res.locals?.accessToken || null,
        force: req.body?.force || req.query?.force || false,
      });

      const status = payload?.success === false ? 400 : 200;
      return res.status(status).json(payload);
    } catch (error) {
      console.error("Erro em NotificationsController.refresh:", error);
      return res.status(500).json({
        success: false,
        error: error?.message || "Falha ao atualizar notificacoes.",
      });
    }
  }

  static async markAllRead(req, res) {
    try {
      const payload = await NotificationsService.markAllRead({
        userId: getUserId(req),
        accountId: getAccountId(req, res),
      });

      const status = payload?.success === false ? 400 : 200;
      return res.status(status).json(payload);
    } catch (error) {
      console.error("Erro em NotificationsController.markAllRead:", error);
      return res.status(500).json({
        success: false,
        error: error?.message || "Falha ao marcar notificacoes como lidas.",
      });
    }
  }
}

module.exports = NotificationsController;
