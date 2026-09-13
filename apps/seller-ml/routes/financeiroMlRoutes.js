"use strict";

const express = require("express");
const FinanceiroMlController = require("../controllers/FinanceiroMlController");

const router = express.Router();

router.get("/costs", FinanceiroMlController.listCosts);
router.get("/costs/export", FinanceiroMlController.exportCosts);
router.post("/costs/sync", FinanceiroMlController.syncCostsCatalog);
router.get("/costs/sync/:jobId", FinanceiroMlController.syncCostsCatalogStatus);
router.post("/costs/import", FinanceiroMlController.importCosts);
router.get("/costs/:sku/timeline", FinanceiroMlController.costTimeline);
router.post("/costs/:sku", FinanceiroMlController.saveCost);
router.get("/settings/tax", FinanceiroMlController.getTax);
router.post("/settings/tax", FinanceiroMlController.saveTax);
router.get("/margin", FinanceiroMlController.listMargin);
router.get("/margin/marketing-summary", FinanceiroMlController.marketingSummary);
router.get("/margin/export", FinanceiroMlController.exportMargin);

module.exports = router;
