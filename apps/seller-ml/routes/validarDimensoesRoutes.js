const express = require("express");
const companyAccessGuards = require("../services/companyAccessService");
const ValidarDimensoesController = require("../controllers/ValidarDimensoesController");
const { createAuditAction } = require("../middleware/auditAction");
const {
  guardSingleOperation,
  requireSingleMlb,
} = require("../services/singleOperationGuardService");

// Analise pura: nao preenche, nao sobrescreve e nao corrige automaticamente.
// Qualquer sinal de escrita (ou modo desconhecido) exige "Editar".
function isDimensionsAnalysisOnly(req) {
  const body = req.body || {};
  if (body.fill_dimensions || body.autofill_from_item || body.force_overwrite) return false;
  const mode = String(body.mode ?? "analyze").trim().toLowerCase();
  return mode === "" || mode === "analyze";
}

const router = express.Router();

// Corrigir dimensoes no anuncio exige "Editar"; apenas analisar segue liberado.
router.use(companyAccessGuards.requireEditForWrites("ml.operacao.validar_dimensoes", {
  readOnlyPaths: ["/credits/quote", "/jobs/:job_id/cancel"],
  isReadRequest: isDimensionsAnalysisOnly,
}));


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
  requireSingleMlb((req) => req.body?.mlb),
  (req, res, next) => {
    const body = req.body || {};
    const mutates =
      !!body.fill_dimensions ||
      body.autofill_from_item === true ||
      body.force_overwrite === true;
    if (!mutates) return next();
    return guardSingleOperation("dimensions.apply")(req, res, next);
  },
  ValidarDimensoesController.analisarItem,
);
router.post(
  "/credits/quote",
  express.json({ limit: "1mb" }),
  ValidarDimensoesController.quoteCredits,
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
