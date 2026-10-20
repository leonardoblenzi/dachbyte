"use strict";

const express = require("express");
const multer = require("multer");
const companyAccess = require("../services/companyAccessService");
const Controller = require("../controllers/BulkSkuController");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
const access = companyAccess.requireModuleAccess("ml.anuncios.cadastro", { defaultAllowIfUnconfigured: true });
const editAccess = companyAccess.requireModuleAccess("ml.anuncios.cadastro", { edit: true, defaultAllowIfUnconfigured: true });

router.use(access);
router.get("/export.xlsx", Controller.exportWorkbook);
router.post("/preview", upload.single("file"), Controller.preview);
router.post("/jobs", editAccess, Controller.createJob);
router.get("/jobs/:id", Controller.getJob);
router.get("/jobs/:id/report.csv", Controller.report);

module.exports = router;
