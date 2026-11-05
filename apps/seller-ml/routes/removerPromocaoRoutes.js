// routes/removerPromocaoRoutes.js
const express = require("express");
const router = express.Router();

const RemoverPromocaoController = require("../controllers/RemoverPromocaoController");
const { createAuditAction } = require("../middleware/auditAction");
const companyAccess = require("../services/companyAccessService");
const {
  guardSingleOperation,
  requireSingleMlb,
} = require("../services/singleOperationGuardService");

router.post(
  "/anuncio/remover-promocao",
  createAuditAction({
    evento: "promotion_remove_single_requested",
    metadata: (req) => ({
      mlb_id: String(req.body?.mlb_id || "").trim().toUpperCase() || null,
    }),
  }),
  companyAccess.requireEditForWrites("ml.promocoes.remover"),
  requireSingleMlb((req) => req.body?.mlb_id),
  guardSingleOperation("promotions.remove"),
  RemoverPromocaoController.removerPromocaoUnica,
);

module.exports = router;
