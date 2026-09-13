"use strict";

const express = require("express");
const { requireAuth } = require("../middlewares/sessionAuth");
const { resolveShop } = require("../utils/resolveShop");
const {
  enqueueAsyncProcessAction,
  getAsyncProcessActionStatus,
  cancelAsyncProcessAction,
} = require("../services/AsyncProcessActionQueueService");

const router = express.Router();
router.use(requireAuth);

router.post("/shops/active/process-jobs", async (req, res, next) => {
  try {
    const shop = await resolveShop(req, "active");
    if (shop?.id) {
      req.auth.activeShopId = Number(shop.id);
    }

    const action = String(req.body?.action || "").trim();
    const payload =
      req.body?.payload && typeof req.body.payload === "object"
        ? req.body.payload
        : {};
    const result = await enqueueAsyncProcessAction({
      action,
      payload,
      auth: req.auth,
    });
    return res.status(202).json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/shops/active/process-jobs/:jobId", async (req, res, next) => {
  try {
    const status = await getAsyncProcessActionStatus({
      jobId: req.params.jobId,
      auth: req.auth,
    });
    return res.json({
      ok: true,
      ...status,
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/shops/active/process-jobs/:jobId", async (req, res, next) => {
  try {
    const result = await cancelAsyncProcessAction({
      jobId: req.params.jobId,
      auth: req.auth,
    });
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
