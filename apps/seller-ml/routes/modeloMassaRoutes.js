"use strict";

const express = require("express");
const ModeloMassaController = require("../controllers/ModeloMassaController");
const companyAccess = require("../services/companyAccessService");
const { createAuditAction } = require("../middleware/auditAction");

const router = express.Router();
const requireModeloAccess = companyAccess.requireModuleAccess("ml.operacao.modelo_massa");
const requireModeloEdit = companyAccess.requireModuleAccess("ml.operacao.modelo_massa", { edit: true });

router.get(
  "/padroes",
  requireModeloAccess,
  ModeloMassaController.listPadroes,
);
router.post(
  "/padroes",
  requireModeloEdit,
  express.json({ limit: "256kb" }),
  createAuditAction({
    evento: "model_mass_default_model_created",
    metadata: (req) => ({
      modelo: String(req.body?.modelo || "").trim() || null,
    }),
  }),
  ModeloMassaController.createPadrao,
);
router.put(
  "/padroes/:padrao_id",
  requireModeloEdit,
  express.json({ limit: "256kb" }),
  createAuditAction({
    evento: "model_mass_default_model_updated",
    metadata: (req) => ({
      padrao_id: String(req.params?.padrao_id || "").trim() || null,
      modelo: String(req.body?.modelo || "").trim() || null,
    }),
  }),
  ModeloMassaController.updatePadrao,
);
router.delete(
  "/padroes/:padrao_id",
  requireModeloEdit,
  createAuditAction({
    evento: "model_mass_default_model_deleted",
    metadata: (req) => ({
      padrao_id: String(req.params?.padrao_id || "").trim() || null,
    }),
  }),
  ModeloMassaController.deletePadrao,
);
router.post(
  "/padroes/:padrao_id/valores",
  requireModeloEdit,
  express.json({ limit: "256kb" }),
  createAuditAction({
    evento: "model_mass_default_model_value_created",
    metadata: (req) => ({
      padrao_id: String(req.params?.padrao_id || "").trim() || null,
      valor: String(req.body?.valor || "").trim() || null,
    }),
  }),
  ModeloMassaController.createPadraoValor,
);
router.put(
  "/padroes/:padrao_id/valores/:valor_id",
  requireModeloEdit,
  express.json({ limit: "256kb" }),
  createAuditAction({
    evento: "model_mass_default_model_value_updated",
    metadata: (req) => ({
      padrao_id: String(req.params?.padrao_id || "").trim() || null,
      valor_id: String(req.params?.valor_id || "").trim() || null,
      valor: String(req.body?.valor || "").trim() || null,
    }),
  }),
  ModeloMassaController.updatePadraoValor,
);
router.delete(
  "/padroes/:padrao_id/valores/:valor_id",
  requireModeloEdit,
  createAuditAction({
    evento: "model_mass_default_model_value_deleted",
    metadata: (req) => ({
      padrao_id: String(req.params?.padrao_id || "").trim() || null,
      valor_id: String(req.params?.valor_id || "").trim() || null,
    }),
  }),
  ModeloMassaController.deletePadraoValor,
);
router.get(
  "/jobs",
  requireModeloAccess,
  ModeloMassaController.listJobs,
);
router.get(
  "/jobs/:job_id",
  requireModeloAccess,
  ModeloMassaController.jobDetail,
);
router.get(
  "/jobs/:job_id/download.csv",
  requireModeloAccess,
  ModeloMassaController.downloadCsv,
);
router.post(
  "/jobs/:job_id/cancel",
  requireModeloEdit,
  createAuditAction({
    evento: "model_mass_job_canceled",
    metadata: (req) => ({
      job_id: String(req.params?.job_id || "").trim() || null,
    }),
  }),
  ModeloMassaController.cancelJob,
);
router.post(
  "/preview",
  requireModeloAccess,
  createAuditAction({
    evento: "model_mass_preview_requested",
    metadata: (req) => ({
      total_items: Array.isArray(req.body?.mlb_ids) ? req.body.mlb_ids.length : 0,
      sample_ids: Array.isArray(req.body?.mlb_ids) ? req.body.mlb_ids.slice(0, 20) : [],
      modelo: String(req.body?.modelo || req.body?.modelo_template || "").trim() || null,
    }),
  }),
  express.json({ limit: "1mb" }),
  ModeloMassaController.preview,
);
router.post(
  "/aplicar",
  requireModeloEdit,
  createAuditAction({
    evento: "model_mass_apply_started",
    metadata: (req) => ({
      total_items: Array.isArray(req.body?.mlb_ids) ? req.body.mlb_ids.length : 0,
      sample_ids: Array.isArray(req.body?.mlb_ids) ? req.body.mlb_ids.slice(0, 20) : [],
      modelo: String(req.body?.modelo || req.body?.modelo_template || "").trim() || null,
    }),
  }),
  express.json({ limit: "1mb" }),
  ModeloMassaController.apply,
);

module.exports = router;
