const express = require("express");
const LogisticsController = require("../controllers/LogisticsController");
const { requireAuth } = require("../middlewares/sessionAuth");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

router.use(requireAuth);

router.get("/logistics/shops", asyncHandler(LogisticsController.list));
router.get(
  "/shops/active/logistics/products",
  asyncHandler(LogisticsController.list),
);
router.post(
  "/logistics/spx/enable",
  asyncHandler(LogisticsController.enableSpx),
);
router.post(
  "/logistics/spx/disable",
  asyncHandler(LogisticsController.disableSpx),
);
router.post(
  "/shops/active/logistics/spx/enable",
  asyncHandler(LogisticsController.enableSpx),
);
router.post(
  "/shops/active/logistics/spx/disable",
  asyncHandler(LogisticsController.disableSpx),
);
router.post(
  "/logistics/seller/enable",
  asyncHandler(LogisticsController.enableSellerLogistics),
);
router.post(
  "/logistics/seller/disable",
  asyncHandler(LogisticsController.disableSellerLogistics),
);
router.post(
  "/shops/active/logistics/seller/enable",
  asyncHandler(LogisticsController.enableSellerLogistics),
);
router.post(
  "/shops/active/logistics/seller/disable",
  asyncHandler(LogisticsController.disableSellerLogistics),
);
router.post(
  "/shops/active/logistics/conflicts/keep-spx",
  asyncHandler(LogisticsController.resolveConflictsKeepSpx),
);
router.post(
  "/shops/active/logistics/conflicts/keep-seller",
  asyncHandler(LogisticsController.resolveConflictsKeepSeller),
);
router.post(
  "/shops/active/logistics/mapping/apply",
  asyncHandler(LogisticsController.applyAutomaticMapping),
);

module.exports = router;
router.post(
  "/shops/active/logistics/configure",
  asyncHandler(LogisticsController.configure),
);
