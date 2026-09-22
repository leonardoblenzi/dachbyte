"use strict";

const express = require("express");
const Controller = require("../controllers/EstoqueAlertaController");
const UpdatePreviewController = require("../controllers/EstoqueAtualizacaoPreviewController");
const UpdateController = require("../controllers/EstoqueAtualizacaoController");
const { createAuditAction } = require("../middleware/auditAction");

const router = express.Router();

router.get("/alerta", Controller.list);
router.get("/alerta/risk-kpi", Controller.riskKpi);

router.post(
  "/alerta/analisar",
  createAuditAction({
    evento: "stock_alert_analysis_requested",
    metadata: (req) => ({ source: req.body?.source || "manual" }),
  }),
  Controller.analyze,
);

router.post(
  "/alerta/analisar-job",
  createAuditAction({
    evento: "stock_alert_job_started",
    metadata: (req) => ({ source: req.body?.source || "sold_period", max_items: req.body?.max_items || null }),
  }),
  Controller.enqueue,
);

router.post(
  "/alerta/:mlb/compra-realizada",
  createAuditAction({
    evento: "stock_purchase_marked",
    metadata: (req) => ({ mlb: req.params?.mlb || null, expected_arrival_date: req.body?.expected_arrival_date || null }),
  }),
  Controller.markPurchase,
);

router.post(
  "/alerta/:mlb/limpar-compra",
  createAuditAction({
    evento: "stock_purchase_cleared",
    metadata: (req) => ({ mlb: req.params?.mlb || null }),
  }),
  Controller.clearPurchase,
);

router.delete(
  "/alerta/:mlb",
  createAuditAction({
    evento: "stock_watch_item_removed",
    metadata: (req) => ({ mlb: req.params?.mlb || null }),
  }),
  Controller.removeWatchItem,
);

router.get("/alerta/jobs", Controller.listJobs);
router.get("/alerta/jobs/:id", Controller.detailJob);
router.get("/alerta/jobs/:id/download.csv", Controller.downloadJob);
router.post("/alerta/jobs/:id/cancel", Controller.cancelJob);

// ---------------------------------------------------------------------------
// Atualizacao de estoque — leitura, revisao e processamento em fila.
// ---------------------------------------------------------------------------
router.post(
  "/atualizacao/carregar",
  createAuditAction({
    evento: "stock_bulk_load_requested",
    metadata: (req) => ({
      source: req.body?.source || "active",
      has_query: Boolean(String(req.body?.query || req.body?.items || "").trim()),
      max_items: req.body?.max_items ?? req.body?.maxItems ?? null,
    }),
  }),
  UpdatePreviewController.loadRows,
);

router.post(
  "/atualizacao/preview",
  createAuditAction({
    evento: "stock_bulk_preview_requested",
    metadata: (req) => ({
      rows: Array.isArray(req.body?.changes) ? req.body.changes.length : 0,
    }),
  }),
  UpdatePreviewController.preview,
);

router.post(
  "/atualizacao/aplicar",
  createAuditAction({
    evento: "stock_bulk_update_requested",
    metadata: (req) => ({
      rows: Array.isArray(req.body?.changes) ? req.body.changes.length : 0,
    }),
  }),
  UpdateController.enqueue,
);

router.get("/atualizacao/jobs", UpdateController.listJobs);
router.get("/atualizacao/jobs/:id", UpdateController.detailJob);
router.get("/atualizacao/jobs/:id/download.csv", UpdateController.downloadJob);
router.post(
  "/atualizacao/jobs/:id/cancel",
  createAuditAction({ evento: "stock_bulk_update_cancel_requested" }),
  UpdateController.cancelJob,
);
router.post(
  "/atualizacao/jobs/:id/retry-errors",
  createAuditAction({ evento: "stock_bulk_update_retry_requested" }),
  UpdateController.retryErrors,
);

module.exports = router;
