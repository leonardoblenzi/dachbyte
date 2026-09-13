"use strict";

const express = require("express");
const AtacadoController = require("../controllers/AtacadoController");
const companyAccess = require("../services/companyAccessService");
const { createAuditAction } = require("../middleware/auditAction");

const router = express.Router();
const requireAtacadoAccess = companyAccess.requireModuleAccess("ml.operacao.atacado");
const requireAtacadoEdit = companyAccess.requireModuleAccess("ml.operacao.atacado", { edit: true });

router.get("/jobs", requireAtacadoAccess, AtacadoController.listJobs);
router.get(
  "/jobs/:job_id",
  requireAtacadoAccess,
  AtacadoController.jobDetail,
);
router.get(
  "/jobs/:job_id/download.csv",
  requireAtacadoAccess,
  AtacadoController.downloadCsv,
);
router.post(
  "/jobs/:job_id/cancel",
  requireAtacadoEdit,
  createAuditAction({
    evento: "wholesale_price_job_canceled",
    metadata: (req) => ({
      job_id: String(req.params?.job_id || "").trim() || null,
    }),
  }),
  AtacadoController.cancelJob,
);
router.get("/ativos", requireAtacadoAccess, AtacadoController.listActive);
router.post(
  "/listar-especificos",
  requireAtacadoAccess,
  express.json({ limit: "1mb" }),
  AtacadoController.listSpecific,
);
router.post(
  "/aplicar",
  requireAtacadoEdit,
  express.json({ limit: "1mb" }),
  createAuditAction({
    evento: "wholesale_price_apply_started",
    metadata: (req) => ({
      total_items: Array.isArray(req.body?.item_ids) ? req.body.item_ids.length : 0,
      sample_ids: Array.isArray(req.body?.item_ids)
        ? req.body.item_ids.slice(0, 20)
        : [],
      extra_discount_percent: Number(req.body?.extra_discount_percent || 0) || null,
      min_purchase_unit: Number(req.body?.min_purchase_unit || 0) || null,
      tier_configs: Array.isArray(req.body?.tier_configs) ? req.body.tier_configs : null,
      tier_count: Array.isArray(req.body?.tier_configs) ? req.body.tier_configs.length : 1,
      promo_only: req.body?.promo_only !== false,
      dry_run: req.body?.dry_run === true,
    }),
  }),
  AtacadoController.apply,
);

module.exports = router;
