const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const AuthController = require("../controllers/AuthController");
const { sessionAuth, requireAuth } = require("../middlewares/sessionAuth");

const router = express.Router();

router.get(
  "/auth/url",
  sessionAuth,
  requireAuth,
  asyncHandler(AuthController.getAuthUrl)
);
router.get(
  "/auth/ads/url",
  sessionAuth,
  requireAuth,
  asyncHandler(AuthController.getAdsAuthUrl)
);
router.get("/auth/callback", sessionAuth, asyncHandler(AuthController.callback));
router.post("/auth/refresh", sessionAuth, requireAuth, asyncHandler(AuthController.refresh));

module.exports = router;
