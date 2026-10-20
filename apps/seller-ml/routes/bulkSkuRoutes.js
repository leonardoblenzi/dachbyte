"use strict";

const express = require("express");
const multer = require("multer");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const companyAccess = require("../services/companyAccessService");
const Controller = require("../controllers/BulkSkuController");

const router = express.Router();
const uploadDir = path.join(__dirname, "..", "results", "bulk-sku", "uploads");
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => { fs.mkdirSync(uploadDir, { recursive: true }); callback(null, uploadDir); },
    filename: (_req, _file, callback) => callback(null, `${crypto.randomUUID()}.xlsx`),
  }),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => callback(null, /\.xlsx$/i.test(file.originalname)),
});
const receiveWorkbook = (req, res, next) => upload.single("file")(req, res, (error) => {
  if (!error) return next();
  return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ ok: false, error: error.code === "LIMIT_FILE_SIZE" ? "A planilha deve ter ate 100 MB." : "Nao foi possivel receber a planilha." });
});
const access = companyAccess.requireModuleAccess("ml.anuncios.cadastro", { defaultAllowIfUnconfigured: true });
const editAccess = companyAccess.requireModuleAccess("ml.anuncios.cadastro", { edit: true, defaultAllowIfUnconfigured: true });

router.use(access);
router.get("/context", Controller.getContext);
router.post("/exports", editAccess, Controller.createExport);
router.get("/exports/:id", Controller.getExport);
router.get("/exports/:id/download.xlsx", Controller.downloadExport);
router.post("/preview", receiveWorkbook, Controller.preview);
router.get("/jobs", Controller.listJobs);
router.post("/jobs", editAccess, Controller.createJob);
router.get("/jobs/:id", Controller.getJob);
router.get("/jobs/:id/report.xlsx", Controller.report);

module.exports = router;
