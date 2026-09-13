const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { requireAuth } = require("../middlewares/sessionAuth");
const FlashSaleController = require("../controllers/FlashSaleController");

const router = express.Router();

router.use(requireAuth);

router.get(
  "/shops/active/flash-sales/criteria",
  asyncHandler(FlashSaleController.getCriteria),
);
router.get(
  "/shops/active/flash-sales/time-slots",
  asyncHandler(FlashSaleController.getTimeSlots),
);
router.get(
  "/shops/active/flash-sales",
  asyncHandler(FlashSaleController.listFlashSales),
);
router.post(
  "/shops/active/flash-sales",
  asyncHandler(FlashSaleController.createFlashSale),
);
router.get(
  "/shops/active/flash-sales/:flashSaleId",
  asyncHandler(FlashSaleController.getFlashSale),
);
router.get(
  "/shops/active/flash-sales/:flashSaleId/items",
  asyncHandler(FlashSaleController.getFlashSaleItems),
);
router.post(
  "/shops/active/flash-sales/:flashSaleId/items",
  asyncHandler(FlashSaleController.addItems),
);
router.post(
  "/shops/active/flash-sales/:flashSaleId/status",
  asyncHandler(FlashSaleController.updateStatus),
);
router.post(
  "/shops/active/flash-sales/:flashSaleId/items/update",
  asyncHandler(FlashSaleController.updateItems),
);
router.post(
  "/shops/active/flash-sales/:flashSaleId/items/delete",
  asyncHandler(FlashSaleController.deleteItems),
);
router.post(
  "/shops/active/flash-sales/:flashSaleId/delete",
  asyncHandler(FlashSaleController.deleteFlashSale),
);
router.post(
  "/shops/active/flash-sales/:flashSaleId/duplicate",
  asyncHandler(FlashSaleController.duplicateFlashSale),
);

module.exports = router;
