// routes/excluirAnuncioRoutes.js
const express = require('express');
const router = express.Router();

const companyAccess = require('../services/companyAccessService');
const ExcluirAnuncioController = require('../controllers/ExcluirAnuncioController');
const { createAuditAction } = require('../middleware/auditAction');

router.use(companyAccess.requireModuleAccess('ml.operacao.excluir_massa'));
const requireExcluirEdit = companyAccess.requireModuleAccess('ml.operacao.excluir_massa', { edit: true });

// 🔹 Excluir um único anúncio (DELETE /anuncios/excluir/:mlb_id)
router.delete('/anuncios/excluir/:mlb_id', requireExcluirEdit, ExcluirAnuncioController.excluirUnico);

// 🔹 Exclusão em lote (POST /anuncios/excluir-lote)
router.post('/anuncios/excluir-lote', requireExcluirEdit, ExcluirAnuncioController.excluirLote);
router.post('/anuncios/operacoes-lote', requireExcluirEdit, ExcluirAnuncioController.operarLote);

// 🔹 Status da exclusão em lote (GET /anuncios/status-exclusao/:id)
router.get('/anuncios/status-exclusao/:id', ExcluirAnuncioController.status);

router.get('/jobs', ExcluirAnuncioController.listJobs);
router.get('/jobs/:id', ExcluirAnuncioController.jobDetail);
router.get(
  '/jobs/:id/download.csv',
  createAuditAction({
    evento: 'listing_management_results_downloaded',
    metadata: (req) => ({
      job_id: String(req.params?.id || '').trim() || null,
    }),
  }),
  ExcluirAnuncioController.downloadCsv,
);
router.post(
  '/jobs/:id/cancel',
  requireExcluirEdit,
  createAuditAction({
    evento: 'listing_management_cancel_request_received',
    metadata: (req) => ({
      job_id: String(req.params?.id || '').trim() || null,
    }),
  }),
  ExcluirAnuncioController.cancelJob,
);

module.exports = router;
