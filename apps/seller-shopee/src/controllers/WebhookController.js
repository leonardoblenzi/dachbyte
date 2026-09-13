"use strict";

const { verifyShopeePush } = require("../webhooks/shopeePushVerifier");
const {
  processShopeePushPayload,
} = require("../services/ShopeePushProcessingService");
const {
  enqueueShopeeWebhookPush,
} = require("../config/queue");
const {
  getShopeeWebhookCategoryFromCode,
  normalizeShopeeWebhookCategory,
} = require("../webhooks/shopeePushCategories");

async function receiveShopeePush(req, res) {
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const code = Number(payload.code) || null;
  const payloadCategory = normalizeShopeeWebhookCategory(
    payload.category ||
      payload.push_category ||
      payload.pushCategory ||
      payload.event ||
      payload.event_name ||
      payload.eventName,
  );
  const category =
    payloadCategory !== "unknown"
      ? payloadCategory
      : getShopeeWebhookCategoryFromCode(code);
  const verification = verifyShopeePush(req);

  // Shopee exige 2xx em atÃ© 3s para validar callback; sempre respondemos rapidamente.
  res.status(200).json({
    ok: true,
    accepted: true,
    code,
    queued: false,
    processing: "direct",
  });

  // Apenas POST deve seguir para processamento.
  if (String(req.method || "").toUpperCase() !== "POST") {
    return;
  }

  if (!verification.ok) {
    console.warn("[webhook] push ignored due to signature verification failure", {
      code,
      category,
      reason: verification.reason || "invalid_signature",
      path: req.originalUrl || req.path,
    });
    return;
  }

  try {
    await processShopeePushPayload(payload);
    return;
  } catch (error) {
    console.error("[webhook] direct processing failed, enqueueing backup", {
      code,
      category,
      error: String(error?.message || error),
    });

    try {
      await enqueueShopeeWebhookPush({
        category,
        payload,
        code,
      });
      return;
    } catch (enqueueError) {
      console.error("[webhook] backup enqueue failed", {
        code,
        category,
        error: String(enqueueError?.message || enqueueError),
      });
    }
  }
}

module.exports = {
  receiveShopeePush,
};
