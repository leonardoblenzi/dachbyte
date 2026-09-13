// shopee/src/routes/index.js
const express = require("express");
const healthRoutes = require("./health.routes");
const authRoutes = require("./auth.routes");
const authLocalRoutes = require("./authLocal.routes");
const sessionRoutes = require("./session.routes");
const ordersRoutes = require("./orders.routes");
const productsRoutes = require("./products.routes");
const debugRoutes = require("./debug.routes");
const adminRoutes = require("./admin.routes");
const adminMasterRoutes = require("./adminMaster.routes");
const supportRoutes = require("./support.routes");
const { sessionAuth } = require("../middlewares/sessionAuth");
const adsRoutes = require("./ads.routes");
const discountRoutes = require("./discount.routes");
const flashSaleRoutes = require("./flashSale.routes");
const metricsRoutes = require("./metrics.routes");
const catalogQualityRoutes = require("./catalogQuality.routes");
const logisticsRoutes = require("./logistics.routes");
const listingCloneRoutes = require("./listingClone.routes");
const asyncProcessRoutes = require("./asyncProcess.routes");
const billingRoutes = require("./billing.routes");
const pricingV6Routes = require("./pricingV6.routes");
const giftCampaignRoutes = require("./giftCampaign.routes");
const MarginController = require("../controllers/MarginController");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

if (process.env.ENABLE_DEBUG_ROUTES === "true") {
  router.use(debugRoutes);
}

// rotas públicas
router.use(require("./seo"));
router.use(sessionRoutes);
router.use(healthRoutes);
router.use(authLocalRoutes);
router.use(authRoutes);
router.use(require("./webhooks.routes"));

// daqui pra frente: protegido
router.use(sessionAuth);

router.use(require("./seo.authed"));

// IMPORTANTE: sem /shopee aqui dentro
router.use("/discounts", discountRoutes);
router.use("/", flashSaleRoutes);
router.use("/", adminRoutes);
router.use("/", adminMasterRoutes);
router.use("/", supportRoutes);
router.use("/", ordersRoutes);
router.use("/", productsRoutes);
router.use("/", adsRoutes);
router.use("/", metricsRoutes);
router.use("/", catalogQualityRoutes);
router.use("/", logisticsRoutes);
router.use("/", listingCloneRoutes);
router.use("/", asyncProcessRoutes);
router.use("/", billingRoutes);
router.use("/", pricingV6Routes);
router.use("/", giftCampaignRoutes);

router.get("/dashboard/margin", asyncHandler(MarginController.getMarginData));

router.get(
  "/dashboard/margin/orders",
  asyncHandler(MarginController.getMarginOrderDetails),
);

module.exports = router;
