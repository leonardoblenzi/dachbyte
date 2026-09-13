const express = require("express");
const { requireAuth } = require("../middlewares/sessionAuth");
const MetricsController = require("../controllers/MetricsController");

const router = express.Router();

router.use(requireAuth);

router.get("/shops/active/metrics/overview", MetricsController.overview);
router.get(
  "/shops/active/metrics/products/:itemId",
  MetricsController.productCompare,
);

module.exports = router;
