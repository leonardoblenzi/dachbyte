const router = require("express").Router();
const SeoController = require("../controllers/seoController");
const { requireAuth } = require("../middlewares/sessionAuth");

router.get(
  "/shops/:shopId/seo/ref-products",
  requireAuth,
  SeoController.refProducts,
);
router.get(
  "/shops/:shopId/seo/shopee-recommended-keywords",
  requireAuth,
  SeoController.shopeeRecommendedKeywords,
);

module.exports = router;
