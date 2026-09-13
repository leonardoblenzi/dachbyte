"use strict";

const express = require("express");
const multer = require("multer");
const CaracteristicasController = require("../controllers/CaracteristicasController");
const companyAccess = require("../services/companyAccessService");
const { createAuditAction } = require("../middleware/auditAction");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const requireCaracteristicasAccess = companyAccess.requireModuleAccess("ml.operacao.caracteristicas");
const requireCaracteristicasEdit = companyAccess.requireModuleAccess("ml.operacao.caracteristicas", { edit: true });

router.get(
  "/categorias",
  requireCaracteristicasAccess,
  CaracteristicasController.searchCategories,
);

router.get(
  "/categorias-conta",
  requireCaracteristicasAccess,
  CaracteristicasController.listAccountCategories,
);

router.get(
  "/exportar",
  requireCaracteristicasAccess,
  createAuditAction({
    evento: "characteristics_preview_requested",
    metadata: (req) => ({
      category_id: String(req.query?.category_id || "").trim() || null,
      export_type: String(req.query?.mode || "filled"),
    }),
  }),
  CaracteristicasController.exportCategoryWorkbook,
);

router.post(
  "/importar/validar",
  requireCaracteristicasAccess,
  upload.single("file"),
  CaracteristicasController.validateImport,
);

router.get(
  "/jobs",
  requireCaracteristicasAccess,
  CaracteristicasController.listJobs,
);

router.get(
  "/jobs/:job_id",
  requireCaracteristicasAccess,
  CaracteristicasController.jobDetail,
);

router.get(
  "/jobs/:job_id/download.csv",
  requireCaracteristicasAccess,
  CaracteristicasController.downloadJobCsv,
);

router.post(
  "/jobs/:job_id/cancel",
  requireCaracteristicasEdit,
  CaracteristicasController.cancelJob,
);

router.post(
  "/preview",
  requireCaracteristicasAccess,
  createAuditAction({
    evento: "characteristics_preview_requested",
    metadata: (req) => ({
      category_id: String(req.body?.category_id || "").trim() || null,
      total_items: Array.isArray(req.body?.item_ids) ? req.body.item_ids.length : 0,
      sample_ids: Array.isArray(req.body?.item_ids) ? req.body.item_ids.slice(0, 20) : [],
    }),
  }),
  express.json({ limit: "2mb" }),
  CaracteristicasController.preview,
);

router.post(
  "/aplicar",
  requireCaracteristicasEdit,
  createAuditAction({
    evento: "characteristics_apply_started",
    metadata: (req) => ({
      category_id: String(req.body?.category_id || "").trim() || null,
      total_items: Array.isArray(req.body?.item_ids) ? req.body.item_ids.length : 0,
      total_attributes: Array.isArray(req.body?.attributes) ? req.body.attributes.length : 0,
      dry_run: Boolean(req.body?.dry_run),
    }),
  }),
  express.json({ limit: "4mb" }),
  CaracteristicasController.apply,
);

router.post(
  "/aplicar-excel",
  requireCaracteristicasEdit,
  createAuditAction({
    evento: "characteristics_apply_started",
    metadata: (req) => ({
      category_id: String(req.body?.category_id || "").trim() || null,
      total_items: Array.isArray(req.body?.rows) ? req.body.rows.length : 0,
      dry_run: Boolean(req.body?.dry_run),
      source: "excel",
    }),
  }),
  express.json({ limit: "8mb" }),
  CaracteristicasController.applyExcel,
);

module.exports = router;
