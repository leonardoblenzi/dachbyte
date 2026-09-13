"use strict";

const express = require("express");
const PromoOfferRefsService = require("../services/promoOfferRefsService");

const router = express.Router();

router.post("/webhooks/notifications", async (req, res) => {
  try {
    const payload = req.body || {};
    const result = await PromoOfferRefsService.consumeNotification(payload);
    return res.status(202).json(result);
  } catch (error) {
    console.error("[/api/meli/webhooks/notifications] erro:", error);
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
    });
  }
});

module.exports = router;
