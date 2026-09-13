const express = require("express");
const DebugShopeeController = require("../controllers/DebugShopeeController");
const { requireDebugToken } = require("../middlewares/debugToken");

const router = express.Router();

router.get("/debug/ping", (req, res) =>
  res.json({ status: "ok", debug: true })
);

router.get(
  "/debug/shops/active/orders/:orderSn/masked-check",
  requireDebugToken,
  DebugShopeeController.testShopeeOrderDetailMask
);

module.exports = router;
