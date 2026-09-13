const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const WebhookController = require("../controllers/WebhookController");

const router = express.Router();

const SHOPEE_PUSH_CALLBACK_PATHS = [
  "/webhooks/shopee/push",
  "/shopee/webhooks/shopee/push",
];

for (const callbackPath of SHOPEE_PUSH_CALLBACK_PATHS) {
  router.all(
    callbackPath,
    asyncHandler(WebhookController.receiveShopeePush),
  );
}

module.exports = router;
