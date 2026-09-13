// routes/removerPromocaoRoutes.js
const express = require("express");
const router = express.Router();

const RemoverPromocaoController = require("../controllers/RemoverPromocaoController");
const { createAuditAction } = require("../middleware/auditAction");

router.post(
  "/anuncio/remover-promocao",
  createAuditAction({
    evento: "promotion_remove_single_requested",
    metadata: (req) => ({
      mlb_id: String(req.body?.mlb_id || "").trim().toUpperCase() || null,
    }),
  }),
  RemoverPromocaoController.removerPromocaoUnica,
);

module.exports = router;
