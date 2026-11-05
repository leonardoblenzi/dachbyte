"use strict";

const express = require("express");
const companyAccessGuards = require("../services/companyAccessService");
const ClonarAnuncioController = require("../controllers/ClonarAnuncioController");

const router = express.Router();

// Criar rascunho e publicar anuncio exige "Editar"; a previa segue liberada.
router.use(companyAccessGuards.requireEditForWrites("ml.anuncios.clonar", {
  readOnlyPaths: ["/preview", "/drafts/:id/credits/quote"],
}));


router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.post("/preview", ClonarAnuncioController.preview);
router.post("/drafts", ClonarAnuncioController.createDraft);
router.post("/browser-capture", ClonarAnuncioController.createDraftFromBrowserCapture);
router.get("/drafts", ClonarAnuncioController.listDrafts);
router.get("/drafts/:id", ClonarAnuncioController.getDraft);
router.put("/drafts/:id", ClonarAnuncioController.updateDraft);
router.post("/drafts/:id/validate", ClonarAnuncioController.validateDraft);
router.post("/drafts/:id/credits/quote", ClonarAnuncioController.quotePublishCredits);
router.post("/drafts/:id/publish", ClonarAnuncioController.publishDraft);

module.exports = router;
