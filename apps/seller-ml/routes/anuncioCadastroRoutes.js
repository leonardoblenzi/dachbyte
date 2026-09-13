"use strict";

const express = require("express");
const Controller = require("../controllers/AnuncioCadastroController");
const companyAccess = require("../services/companyAccessService");
const multer = require("multer");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
const access = companyAccess.requireModuleAccess("ml.anuncios.cadastro", { defaultAllowIfUnconfigured: true });
const editAccess = companyAccess.requireModuleAccess("ml.anuncios.cadastro", { edit: true, defaultAllowIfUnconfigured: true });

router.use(access);
router.get("/capabilities", Controller.capabilities);
router.get("/own-items", Controller.searchOwn);
router.get("/categories/suggest", Controller.suggestCategories);
router.get("/categories/:categoryId/attributes", Controller.categoryAttributes);
router.get("/listing-types", Controller.listingTypes);
router.post("/pictures", editAccess, upload.single("file"), Controller.uploadPicture);
router.post("/source/resolve", Controller.resolveSource);

router.get("/groups", Controller.listGroups);
router.get("/groups/:id", Controller.getGroup);
router.post("/groups/batch-copy", editAccess, Controller.createBatchCopies);
router.post("/family-clone/preview", editAccess, Controller.previewFamilyClone);
router.post("/family-clone", editAccess, Controller.createFamilyClone);

router.get("/drafts", Controller.listDrafts);
router.post("/drafts", editAccess, Controller.createBlank);
router.post("/drafts/from-source", editAccess, Controller.createFromSource);
router.get("/drafts/:id", Controller.getDraft);
router.patch("/drafts/:id", editAccess, Controller.updateDraft);
router.post("/drafts/:id/duplicate", editAccess, Controller.duplicateDraft);
router.delete("/drafts/:id", editAccess, Controller.deleteDraft);
router.post("/drafts/:id/restore", editAccess, Controller.restoreDraft);
router.post("/drafts/:id/validate", editAccess, Controller.validateDraft);
router.post("/drafts/:id/publish", editAccess, Controller.publishDraft);

module.exports = router;
