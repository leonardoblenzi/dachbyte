const express = require("express");
const { requireAuth } = require("../middlewares/sessionAuth");
const asyncHandler = require("../utils/asyncHandler");
const AdsController = require("../controllers/AdsController");
const AdsCampaignGroupsController = require("../controllers/AdsCampaignGroupsController");
const AdsBoostController = require("../controllers/AdsBoostController");
const { chargeOperation } = require("../middlewares/shopeeCreditBilling");
const router = express.Router();
router.use(requireAuth);

router.get("/shops/:shopId/ads/balance", AdsController.balance);
router.get(
  "/shops/:shopId/ads/performance/daily",
  chargeOperation("shopee.ads.report"),
  AdsController.dailyPerformance,
);

router.get("/shops/:shopId/ads/campaigns/ids", AdsController.listCampaignIds);
router.get(
  "/shops/:shopId/ads/campaigns/grouped",
  chargeOperation("shopee.ads.enrichment"),
  AdsController.groupedCampaigns,
);
router.get(
  "/shops/:shopId/ads/campaigns/settings",
  chargeOperation("shopee.ads.enrichment"),
  AdsController.campaignSettings,
);

router.get(
  "/shops/:shopId/ads/cpc/hourly",
  chargeOperation("shopee.ads.report"),
  AdsController.hourlyPerformance,
);

router.get(
  "/shops/:shopId/ads/intelligence/overview",
  chargeOperation("shopee.ads.enrichment"),
  AdsController.intelligenceOverview,
);

router.post(
  "/shops/:shopId/ads/intelligence/simulate",
  chargeOperation("shopee.ads.enrichment"),
  AdsController.intelligenceSimulate,
);

router.post(
  "/shops/:shopId/ads/intelligence/apply",
  chargeOperation("shopee.ads.apply"),
  AdsController.intelligenceApply,
);

router.get(
  "/shops/:shopId/ads/roas-real-aproximado",
  chargeOperation("shopee.ads.report"),
  AdsController.roasRealApprox,
);

router.get(
  "/shops/:shopId/ads/campaigns/performance/daily",
  chargeOperation("shopee.ads.report"),
  AdsController.campaignsDailyPerformance,
);

router.post(
  "/shops/:shopId/ads/campaigns/items/performance",
  chargeOperation("shopee.ads.enrichment"),
  AdsController.campaignItemsPerformance,
);

router.get(
  "/shops/active/ads/boost/overview",
  asyncHandler(AdsBoostController.overview),
);

router.post(
  "/shops/active/ads/boost/run",
  chargeOperation("shopee.ads.boost"),
  asyncHandler(AdsBoostController.run),
);

router.get(
  "/shops/:shopId/ads/campaign-groups",
  AdsCampaignGroupsController.list,
);

router.post(
  "/shops/:shopId/ads/campaign-groups",
  AdsCampaignGroupsController.create,
);

router.put(
  "/shops/:shopId/ads/campaign-groups/:groupId",
  AdsCampaignGroupsController.update,
);

router.delete(
  "/shops/:shopId/ads/campaign-groups/:groupId",
  AdsCampaignGroupsController.remove,
);

module.exports = router;
