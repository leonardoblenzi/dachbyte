const express = require("express");
const ValidarDimensoesController = require("../controllers/ValidarDimensoesController");
const { createAuditAction } = require("../middleware/auditAction");

const router = express.Router();

router.post(
  "/analisar-item",
  createAuditAction({
    evento: "dimensions_validation_single_requested",
    metadata: (req) => ({
      item_id: String(req.body?.item_id || req.body?.mlb_id || req.body?.mlb || "")
        .trim()
        .toUpperCase() || null,
    }),
  }),
  ValidarDimensoesController.analisarItem,
);
router.post(
  "/jobs",
  createAuditAction({
    evento: "dimensions_validation_bulk_started",
    metadata: (req) => ({
      total_items:
        String(req.body?.source || "").trim().toLowerCase() === "active_items"
          ? null
          : Array.isArray(req.body?.mlbs)
            ? req.body.mlbs.length
            : 0,
      sample_ids: Array.isArray(req.body?.mlbs) ? req.body.mlbs.slice(0, 20) : [],
      source: String(req.body?.source || "").trim().toLowerCase() === "active_items"
        ? "active_items"
        : "manual_list",
    }),
  }),
  ValidarDimensoesController.analisarLote,
);
router.get("/jobs", ValidarDimensoesController.listarJobs);
router.get("/jobs/:job_id", ValidarDimensoesController.obterJob);
router.get("/jobs/:job_id/items", ValidarDimensoesController.obterPaginaResultados);
router.get("/jobs/:job_id/results", ValidarDimensoesController.obterResultados);
router.get(
  "/jobs/:job_id/download.csv",
  createAuditAction({
    evento: "dimensions_validation_results_downloaded",
    metadata: (req) => ({
      job_id: String(req.params?.job_id || "").trim() || null,
    }),
  }),
  ValidarDimensoesController.baixarCsv,
);
router.post(
  "/jobs/:job_id/cancel",
  createAuditAction({
    evento: "dimensions_validation_job_canceled",
    metadata: (req) => ({
      job_id: String(req.params?.job_id || "").trim() || null,
    }),
  }),
  ValidarDimensoesController.cancelarJob,
);

module.exports = router;
