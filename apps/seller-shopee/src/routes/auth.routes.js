const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const AuthController = require("../controllers/AuthController");
const { createPublicTrialOAuthController } = require("../controllers/PublicTrialOAuthController");
const { sessionAuth, requireAuth } = require("../middlewares/sessionAuth");

const router = express.Router();
const PublicTrialOAuthController = createPublicTrialOAuthController();

function isTrialCallback(req) {
  return String(req.query?.state || "").startsWith("trial_");
}

router.get("/auth/trial/availability", asyncHandler(PublicTrialOAuthController.availability));
router.get("/auth/trial/start", asyncHandler(PublicTrialOAuthController.start));
router.post("/auth/trial/email", asyncHandler(PublicTrialOAuthController.email));
router.get("/auth/trial/verify", asyncHandler(PublicTrialOAuthController.verify));
router.post("/auth/trial/activate", asyncHandler(PublicTrialOAuthController.activate));

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
router.get("/auth/callback", (req, res, next) => {
  if (isTrialCallback(req)) {
    return asyncHandler(PublicTrialOAuthController.callback)(req, res, next);
  }
  return next();
});
router.get("/auth/callback", sessionAuth, asyncHandler(AuthController.callback));
router.post("/auth/refresh", sessionAuth, requireAuth, asyncHandler(AuthController.refresh));

module.exports = router;
