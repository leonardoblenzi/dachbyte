"use strict";

const express = require("express");
const ReportService = require("../services/adminMeliAccountPerformanceReportService");

const router = express.Router();

function ensureMasterOnly(req, res, next) {
  const nivel = String(req.user?.nivel || "").trim().toLowerCase();
  if (nivel === "admin_master" || req.user?.is_master === true) return next();
  return res.status(403).json({ ok: false, error: "Acesso restrito ao admin master." });
}

router.use(ensureMasterOnly);

router.get("/meli-account-reports/accounts", async (_req, res, next) => {
  try {
    const accounts = await ReportService.listAccounts();
    return res.json({ ok: true, accounts });
  } catch (error) {
    next(error);
  }
});

router.get("/meli-account-reports/history", async (req, res, next) => {
  try {
    const meliContaId = req.query?.meliContaId == null ? null : Number(req.query.meliContaId);
    const reports = await ReportService.listReports({
      meliContaId: Number.isFinite(meliContaId) ? meliContaId : null,
      limit: 80,
    });
    return res.json({ ok: true, reports });
  } catch (error) {
    next(error);
  }
});

router.post("/meli-account-reports/generate", async (req, res, next) => {
  try {
    const meliContaId = Number(req.body?.meliContaId || req.body?.meli_conta_id);
    if (!Number.isFinite(meliContaId) || meliContaId <= 0) {
      return res.status(400).json({ ok: false, error: "Informe uma conta ML valida." });
    }
    const report = await ReportService.createReport({
      meliContaId,
      userId: req.user?.id || null,
      email: req.user?.email || null,
      periodDays: req.body?.periodDays,
    });
    return res.status(202).json({ ok: true, report });
  } catch (error) {
    next(error);
  }
});

router.get("/meli-account-reports/:id/status", async (req, res, next) => {
  try {
    const report = await ReportService.getReportById(Number(req.params.id));
    if (!report) {
      return res.status(404).json({ ok: false, error: "Relatorio nao encontrado." });
    }
    return res.json({ ok: true, report });
  } catch (error) {
    next(error);
  }
});

router.get("/meli-account-reports/:id/download/:format", async (req, res, next) => {
  try {
    const report = await ReportService.getReportById(Number(req.params.id));
    const file = ReportService.getDownloadInfo(report, req.params.format);
    if (!file) {
      return res.status(404).json({ ok: false, error: "Arquivo do relatorio ainda nao esta disponivel." });
    }
    res.setHeader("Content-Type", file.contentType);
    return res.download(file.path, file.filename);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
