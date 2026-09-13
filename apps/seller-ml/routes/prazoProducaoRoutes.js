"use strict";

const express = require("express");
const PrazoProducaoController = require("../controllers/PrazoProducaoController");
const { createAuditAction } = require("../middleware/auditAction");

const router = express.Router();

router.post(
  "/anuncios/prazo-producao/consultar",
  createAuditAction({
    evento: "production_time_lookup_requested",
    metadata: (req) => ({
      total_items: Array.isArray(req.body?.mlb_ids) ? req.body.mlb_ids.length : 0,
      sample_ids: Array.isArray(req.body?.mlb_ids) ? req.body.mlb_ids.slice(0, 20) : [],
    }),
  }),
  PrazoProducaoController.consultarPrazoProducao
);

router.post(
  "/anuncios/prazo-producao/consultar-ativos-job",
  createAuditAction({
    evento: "production_time_active_lookup_started",
    metadata: (req) => ({
      source: "active_items",
      max_items: Number(req.body?.max_items ?? req.body?.maxItems ?? 0) || null,
    }),
  }),
  PrazoProducaoController.consultarPrazoAtivosJob
);

// Individual
router.post(
  "/anuncio/prazo-producao",
  createAuditAction({
    evento: "production_time_single_updated",
    metadata: (req) => ({
      mlb_id: String(req.body?.mlb_id || req.body?.item_id || "")
        .trim()
        .toUpperCase() || null,
      days: Number(req.body?.days ?? req.body?.prazo_dias ?? 0) || 0,
    }),
  }),
  PrazoProducaoController.setPrazoProducaoSingle
);

// Lote (novo)
router.post(
  "/anuncios/prazo-producao-lote",
  createAuditAction({
    evento: "production_time_bulk_started",
    metadata: (req) => ({
      total_items: Array.isArray(req.body?.mlb_ids) ? req.body.mlb_ids.length : 0,
      sample_ids: Array.isArray(req.body?.mlb_ids) ? req.body.mlb_ids.slice(0, 20) : [],
      days: Number(req.body?.days ?? req.body?.prazo_dias ?? 0) || 0,
      delay_ms: Number(req.body?.delayMs ?? req.body?.delay_ms ?? 0) || 0,
    }),
  }),
  PrazoProducaoController.setPrazoProducaoLote
);

// ✅ Compat LEGADO (prazo-bulk.js antigo)
// - POST /anuncios/prazo-dias-lote      -> body { mlb_ids, days, delay_ms }
// - GET  /anuncios/status-prazo/:id
router.post("/anuncios/prazo-dias-lote", (req, res, next) => {
  // normaliza payload legado -> novo
  const b = req.body || {};
  if (b && b.delay_ms != null && b.delayMs == null) {
    b.delayMs = b.delay_ms;
  }
  req.body = b;
  const auditMiddleware = createAuditAction({
    evento: "production_time_bulk_started",
    metadata: (auditReq) => ({
      total_items: Array.isArray(auditReq.body?.mlb_ids) ? auditReq.body.mlb_ids.length : 0,
      sample_ids: Array.isArray(auditReq.body?.mlb_ids) ? auditReq.body.mlb_ids.slice(0, 20) : [],
      days: Number(auditReq.body?.days ?? auditReq.body?.prazo_dias ?? 0) || 0,
      delay_ms: Number(auditReq.body?.delayMs ?? auditReq.body?.delay_ms ?? 0) || 0,
      source: "legacy_route",
    }),
  });
  return auditMiddleware(req, res, () =>
    PrazoProducaoController.setPrazoProducaoLote(req, res, next)
  );
});

// Status (pra JobsPanel / monitor)
router.get(
  "/anuncios/status-prazo-producao/:id",
  PrazoProducaoController.statusPrazoProducao
);

router.get(
  "/anuncios/jobs-prazo",
  PrazoProducaoController.listJobsPrazoProducao
);

router.get(
  "/anuncios/jobs-prazo/:id",
  PrazoProducaoController.detailJobPrazoProducao
);
router.get(
  "/anuncios/jobs-prazo/:id/download.csv",
  PrazoProducaoController.downloadJobPrazoProducao
);
router.post(
  "/anuncios/jobs-prazo/:id/cancel",
  createAuditAction({
    evento: "production_time_job_canceled",
    metadata: (req) => ({
      job_id: String(req.params?.id || "").trim() || null,
    }),
  }),
  PrazoProducaoController.cancelJobPrazoProducao
);

// ✅ Compat LEGADO
router.get("/anuncios/status-prazo/:id", PrazoProducaoController.statusPrazoProducao);

module.exports = router;
