"use strict";

const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { requireAuth } = require("../middlewares/sessionAuth");
const { chargeOperation } = require("../middlewares/shopeeCreditBilling");
const controller = require("../controllers/PricingV6Controller");

const router = express.Router();
router.use(requireAuth);

router.get("/shops/:shopId/pricing/overview", asyncHandler(controller.overview));
router.get("/shops/:shopId/pricing/tacos", asyncHandler(controller.tacos));
router.post("/shops/:shopId/pricing/catalog/refresh", asyncHandler(controller.refreshCatalog));
router.get("/shops/:shopId/pricing/products", asyncHandler(controller.products));
router.get("/shops/:shopId/pricing/calibration", asyncHandler(controller.calibrationSummary));
router.get("/shops/:shopId/pricing/calibration/orders", asyncHandler(controller.calibrationOrders));
router.post("/shops/:shopId/pricing/calibration/rebuild", asyncHandler(controller.rebuildCalibration));
router.get("/shops/:shopId/pricing/settings", asyncHandler(controller.settings));
router.put("/shops/:shopId/pricing/settings", asyncHandler(controller.updateSettings));
router.post("/shops/:shopId/pricing/simulate", asyncHandler(controller.simulate));
router.post("/shops/:shopId/pricing/price-simulation", asyncHandler(controller.salePriceSimulation));
router.post("/shops/:shopId/pricing/conflicts", asyncHandler(controller.conflicts));
router.get("/shops/:shopId/pricing/jobs", asyncHandler(controller.listJobs));
router.post("/shops/:shopId/pricing/jobs", asyncHandler(controller.createJob));
router.get("/shops/:shopId/pricing/jobs/:jobId", asyncHandler(controller.getJob));
router.post(
  "/shops/:shopId/pricing/jobs/:jobId/confirm",
  chargeOperation("shopee.discounts.publish"),
  asyncHandler(controller.confirmJob),
);
router.post("/shops/:shopId/pricing/jobs/:jobId/cancel", asyncHandler(controller.cancelJob));
router.post(
  "/shops/:shopId/pricing/jobs/:jobId/retry",
  chargeOperation("shopee.discounts.publish"),
  asyncHandler(controller.retryJob),
);
router.get("/shops/:shopId/pricing/audit", asyncHandler(controller.audit));

module.exports = router;
