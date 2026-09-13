const express = require("express");
const ProductsController = require("../controllers/ProductsController");
const ProductSyncController = require("../controllers/ProductSyncController");
const CostsController = require("../controllers/CostsController");
const uploadImages = require("../middlewares/uploadImages");
const { requireAuth } = require("../middlewares/sessionAuth");
const asyncHandler = require("../utils/asyncHandler");
const router = express.Router();
const { resolveShop } = require("../utils/resolveShop");
const PriceIncreaseController = require("../controllers/PriceIncreaseController");

router.use(requireAuth);
router.param("shopId", (req, res, next, shopId) => {
  const s = String(shopId || "").trim();
  if (!/^\d+$/.test(s)) {
    return res.status(404).json({ error: "not_found" }); // ou 400 shopId_invalid
  }
  next();
});

router.get("/shops/active/products/performance", async (req, res, next) => {
  try {
    const shop = await resolveShop(req, "active"); // { id, shopId }
    req.params.shopId = String(shop.id);
    return ProductsController.performance(req, res, next);
  } catch (e) {
    return next(e);
  }
});

router.get("/shops/active/products", async (req, res, next) => {
  try {
    const shop = await resolveShop(req, "active");
    req.params.shopId = String(shop.id);
    return ProductsController.list(req, res, next);
  } catch (e) {
    return next(e);
  }
});

router.get("/shops/active/products/export", async (req, res, next) => {
  try {
    const shop = await resolveShop(req, "active");
    req.params.shopId = String(shop.id);
    return ProductsController.exportFiltered(req, res, next);
  } catch (e) {
    return next(e);
  }
});
router.get(
  "/shops/active/products/promotion-locks",
  asyncHandler(PriceIncreaseController.listActiveLocks),
);

router.post("/shops/active/products/sync", async (req, res, next) => {
  try {
    const shop = await resolveShop(req, "active");
    req.params.shopId = String(shop.id);
    return ProductSyncController.sync(req, res, next);
  } catch (e) {
    return next(e);
  }
});

router.post("/shops/active/products/status/bulk", async (req, res, next) => {
  try {
    const shop = await resolveShop(req, "active");
    req.params.shopId = String(shop.id);
    return ProductsController.bulkListingStatus(req, res, next);
  } catch (e) {
    return next(e);
  }
});

router.param("itemId", (req, res, next, itemId) => {
  const s = String(itemId || "").trim();
  if (!/^\d+$/.test(s)) {
    return res.status(404).json({ error: "not_found" });
  }
  next();
});

router.get("/shops/active/costs", asyncHandler(CostsController.listCosts));
router.get(
  "/shops/active/costs/pricing-items",
  asyncHandler(CostsController.getPricingItems),
);
router.get(
  "/shops/active/costs/vouchers",
  asyncHandler(CostsController.getPricingVouchers),
);
router.get(
  "/shops/active/costs/export",
  asyncHandler(CostsController.exportCosts),
);
router.post(
  "/shops/active/costs/import",
  asyncHandler(CostsController.importCosts),
);
router.patch(
  "/shops/active/products/:id/cost",
  asyncHandler(CostsController.updateCost),
);
router.patch(
  "/shops/active/tax-rate",
  asyncHandler(CostsController.updateTaxRate),
);

router.get(
  "/shops/:shopId/products/performance",
  ProductsController.performance,
);
router.get("/shops/:shopId/products", ProductsController.list);
router.get("/shops/:shopId/products/export", ProductsController.exportFiltered);
router.post("/shops/:shopId/products/sync", ProductSyncController.sync);
// CRUD
router.patch("/shops/:shopId/products/:itemId", ProductsController.updateItem);
router.patch(
  "/shops/:shopId/products/:itemId/price",
  ProductsController.updatePrice,
);
router.patch(
  "/shops/:shopId/products/:itemId/stock",
  ProductsController.updateStock,
);

// Imagens
router.post(
  "/shops/:shopId/products/:itemId/images",
  uploadImages,
  ProductsController.uploadAndApplyImages,
);
router.post(
  "/shops/:shopId/products/:itemId/images/add",
  uploadImages,
  ProductsController.addImages,
);
router.post(
  "/shops/:shopId/products/:itemId/images/remove",
  ProductsController.removeImages,
);

// Curva ABC e Relaunch
router.get("/shops/active/products/curves/abc", async (req, res, next) => {
  try {
    const shop = await resolveShop(req, "active");
    req.params.shopId = String(shop.id);
    return ProductsController.curvesAbc(req, res, next);
  } catch (e) {
    return next(e);
  }
});

router.get("/shops/active/products/relaunch/list", async (req, res, next) => {
  try {
    const shop = await resolveShop(req, "active");
    req.params.shopId = String(shop.id);
    return ProductsController.relaunch(req, res, next);
  } catch (e) {
    return next(e);
  }
});

router.get("/shops/active/products/sales-share", async (req, res, next) => {
  try {
    const shop = await resolveShop(req, "active");
    req.params.shopId = String(shop.id);
    return ProductsController.salesShare(req, res, next);
  } catch (e) {
    return next(e);
  }
});

router.get("/shops/active/products/sales-control", async (req, res, next) => {
  try {
    const shop = await resolveShop(req, "active");
    req.params.shopId = String(shop.id);
    return ProductsController.salesControl(req, res, next);
  } catch (e) {
    return next(e);
  }
});

router.get("/shops/active/products/launches", async (req, res, next) => {
  try {
    const shop = await resolveShop(req, "active");
    req.params.shopId = String(shop.id);
    return ProductsController.launches(req, res, next);
  } catch (e) {
    return next(e);
  }
});

router.post(
  "/shops/active/products/deadline-control/preview",
  async (req, res, next) => {
    try {
      const shop = await resolveShop(req, "active");
      req.params.shopId = String(shop.id);
      return ProductsController.deadlineControlPreview(req, res, next);
    } catch (e) {
      return next(e);
    }
  },
);

router.post(
  "/shops/active/products/deadline-control/apply",
  async (req, res, next) => {
    try {
      const shop = await resolveShop(req, "active");
      req.params.shopId = String(shop.id);
      return ProductsController.deadlineControlApply(req, res, next);
    } catch (e) {
      return next(e);
    }
  },
);

router.get("/shops/:shopId/products/curves/abc", ProductsController.curvesAbc);
router.get(
  "/shops/:shopId/products/relaunch/list",
  ProductsController.relaunch,
);
router.get(
  "/shops/:shopId/products/sales-share",
  ProductsController.salesShare,
);
router.get(
  "/shops/:shopId/products/sales-control",
  ProductsController.salesControl,
);
router.get("/shops/:shopId/products/launches", ProductsController.launches);

router.get("/shops/active/products/:itemId", async (req, res, next) => {
  try {
    const shop = await resolveShop(req, "active");
    req.params.shopId = String(shop.id); // DB id
    return ProductsController.detail(req, res, next);
  } catch (e) {
    return next(e);
  }
});

router.get("/shops/active/products/:itemId/full", async (req, res, next) => {
  try {
    const shop = await resolveShop(req, "active");
    req.params.shopId = String(shop.id); // DB id
    return ProductsController.fullDetail(req, res, next);
  } catch (e) {
    return next(e);
  }
});

router.get("/shops/:shopId/products/:itemId", ProductsController.detail);
router.get(
  "/shops/:shopId/products/:itemId/full",
  ProductsController.fullDetail,
);

router.post("/shops/active/products/relaunch/pause", async (req, res, next) => {
  try {
    const shop = await resolveShop(req, "active");
    req.params.shopId = String(shop.id);
    return await ProductsController.relaunchPause(req, res, next);
  } catch (e) {
    return next(e);
  }
});

router.post(
  "/shops/active/products/relaunch/delete",
  async (req, res, next) => {
    try {
      const shop = await resolveShop(req, "active");
      req.params.shopId = String(shop.id);
      return await ProductsController.relaunchDelete(req, res, next);
    } catch (e) {
      return next(e);
    }
  },
);

module.exports = router;
