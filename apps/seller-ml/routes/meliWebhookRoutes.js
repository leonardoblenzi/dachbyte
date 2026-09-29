"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const MeliWebhookQueueService = require("../services/meliWebhookQueueService");
const { validateWebhookNotification } = require("../services/meliWebhookSecurity");

const router = express.Router();

const webhookRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: Math.max(100, Number(process.env.ML_WEBHOOK_RATE_LIMIT_MAX || 3000) || 3000),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    ok: false,
    error: "Muitas notificacoes recebidas em sequencia.",
  },
});

function expectedApplicationId() {
  const raw = process.env.ML_APP_ID || process.env.APP_ID || process.env.CLIENT_ID;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function requireApplicationId() {
  return String(process.env.ML_WEBHOOK_REQUIRE_APPLICATION_ID || "false")
    .trim()
    .toLowerCase() === "true";
}

router.post("/webhooks/notifications", webhookRateLimiter, async (req, res) => {
  try {
    const validation = validateWebhookNotification(req.body || {}, {
      expectedApplicationId: expectedApplicationId(),
      requireApplicationId: requireApplicationId(),
    });

    if (!validation.ok) {
      console.warn("[/api/meli/webhooks/notifications] payload rejeitado:", validation.reason);
      return res.status(400).json({
        ok: false,
        error: "Notificacao Mercado Livre invalida.",
        reason: validation.reason,
      });
    }

    const queued = await MeliWebhookQueueService.enqueueNotification(
      validation.notification,
    );

    return res.status(202).json({
      ok: true,
      accepted: true,
      job_id: queued.job_id,
      deduplicated: queued.deduplicated === true,
    });
  } catch (error) {
    const status = Number(error?.statusCode || 0);
    if (status >= 400 && status < 500) {
      return res.status(status).json({
        ok: false,
        error: "Notificacao Mercado Livre invalida.",
        reason: error?.reason || error?.code || "invalid_payload",
      });
    }

    console.error("[/api/meli/webhooks/notifications] erro ao enfileirar:", error?.message || error);
    return res.status(503).json({
      ok: false,
      error: "Nao foi possivel aceitar a notificacao no momento.",
    });
  }
});

module.exports = router;
