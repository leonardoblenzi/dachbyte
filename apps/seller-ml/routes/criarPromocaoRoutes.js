// routes/criarPromocaoRoutes.js
const express = require('express');
const router = express.Router();

const CriarPromocaoController = require('../controllers/CriarPromocaoController'); // << path correto
const { createAuditAction } = require('../middleware/auditAction');

function legacyPromotionRemoved(_req, res) {
  return res.status(410).json({
    success: false,
    ok: false,
    error: 'legacy_promotion_flow_removed',
    message:
      'Fluxo legado de PRICE_DISCOUNT removido. Use a Central de Promocoes / Criar promocoes para aplicar campanhas com job e travas de percentual.',
  });
}

// Desconto individual (um MLB)
router.post(
  '/desconto/unico',
  createAuditAction({
    evento: 'promotion_legacy_single_blocked',
    metadata: (req) => ({
      mlb_id: String(req.body?.mlb_id || req.body?.mlb || '').trim().toUpperCase() || null,
      desconto_percentual: Number(req.body?.percentual_desconto ?? req.body?.desconto ?? req.body?.percent ?? 0) || 0,
      legacy_removed: true,
    }),
  }),
  legacyPromotionRemoved,
);

// Desconto individual em lote (vários MLBs)
router.post(
  '/desconto/lote',
  createAuditAction({
    evento: 'promotion_legacy_bulk_blocked',
    metadata: (req) => ({
      total_items: Array.isArray(req.body?.mlb_ids)
        ? req.body.mlb_ids.length
        : String(req.body?.mlbs || '').split(/\r?\n/).map((id) => id.trim()).filter(Boolean).length,
      sample_ids: Array.isArray(req.body?.mlb_ids)
        ? req.body.mlb_ids.slice(0, 20)
        : String(req.body?.mlbs || '').split(/\r?\n/).map((id) => id.trim()).filter(Boolean).slice(0, 20),
      desconto_percentual: Number(req.body?.percentual_desconto ?? req.body?.desconto ?? req.body?.percent ?? 0) || 0,
      legacy_removed: true,
    }),
  }),
  legacyPromotionRemoved,
);

// Status e download do job
router.get('/status/:jobId', CriarPromocaoController.status);
router.get(
  '/download/:jobId',
  createAuditAction({
    evento: 'promotion_legacy_job_downloaded',
    metadata: (req) => ({
      job_id: String(req.params?.jobId || '').trim() || null,
    }),
  }),
  CriarPromocaoController.download,
);

module.exports = router;
