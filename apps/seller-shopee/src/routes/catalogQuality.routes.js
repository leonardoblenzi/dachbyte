const express = require("express");
const { requireAuth } = require("../middlewares/sessionAuth");
const CatalogQualityController = require("../controllers/CatalogQualityController");

const router = express.Router();

router.use(requireAuth);

router.get("/shops/active/catalog-quality", CatalogQualityController.list);
router.get(
  "/shops/active/catalog-quality/clips/without-clip",
  CatalogQualityController.listWithoutClip,
);
router.get(
  "/shops/active/catalog-quality/clips/products",
  CatalogQualityController.listClipProducts,
);
router.get(
  "/shops/active/catalog-quality/export",
  CatalogQualityController.exportReport,
);
router.get(
  "/shops/active/catalog-quality/:itemId",
  CatalogQualityController.detail,
);
router.patch(
  "/shops/active/catalog-quality/:itemId",
  CatalogQualityController.update,
);

module.exports = router;
