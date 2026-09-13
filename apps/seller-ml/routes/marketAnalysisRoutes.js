"use strict";

const express = require("express");
const companyAccess = require("../services/companyAccessService");
const MarketAnalysisController = require("../controllers/MarketAnalysisController");

const router = express.Router();
const requireMarketAnalysisAccess = companyAccess.requireModuleAccess(
  "ml.inteligencia.analise_mercado",
  { defaultAllowIfUnconfigured: true },
);

router.get("/search", requireMarketAnalysisAccess, MarketAnalysisController.search);
router.get("/categories/suggest", requireMarketAnalysisAccess, MarketAnalysisController.categorySuggestions);
router.get("/category/:categoryId", requireMarketAnalysisAccess, MarketAnalysisController.category);
router.get("/keywords", requireMarketAnalysisAccess, MarketAnalysisController.keywords);
router.get("/trends/general", requireMarketAnalysisAccess, MarketAnalysisController.generalTrends);
router.get("/trends/category/:categoryId", requireMarketAnalysisAccess, MarketAnalysisController.categoryTrends);

module.exports = router;
