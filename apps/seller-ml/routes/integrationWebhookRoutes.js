"use strict";

const crypto = require("crypto");
const express = require("express");
const integrations = require("../services/companyIntegrationsService");

const router = express.Router();

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signPayload(payload, secret) {
  return crypto
    .createHmac("sha256", String(secret || ""))
    .update(JSON.stringify(payload || {}))
    .digest("hex");
}

router.post("/:provider/webhook/:integrationId", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    const provider = req.params.provider;
    const integrationId = req.params.integrationId;
    const loaded = await integrations.loadWebhookIntegration({ provider, integrationId });
    if (!loaded?.row || !loaded.webhookSecret) {
      return res.status(404).json({ ok: false, error: "Integracao ativa nao encontrada." });
    }

    const signature = String(req.headers["x-davantti-signature"] || req.headers["x-markflow-signature"] || "").replace(/^sha256=/i, "");
    const expected = signPayload(req.body, loaded.webhookSecret);
    if (!signature || !safeEqual(signature, expected)) {
      return res.status(401).json({ ok: false, error: "Assinatura invalida." });
    }

    const event = await integrations.recordIntegrationEvent({
      integrationId: loaded.row.id,
      provider,
      externalEventId: req.body?.event_id || req.body?.id || null,
      eventType: req.body?.event || req.body?.type || "webhook.received",
      taskId: req.body?.davantti_task_id || req.body?.task_id || null,
      payload: req.body || {},
    });
    const processed = await integrations.processStrategicWebhookEvent({
      integrationId: loaded.row.id,
      provider,
      eventType: req.body?.event || req.body?.type || "webhook.received",
      payload: req.body || {},
    });

    res.json({ ok: true, received: true, event_id: event?.id ? String(event.id) : null, processed });
  } catch (error) {
    res.status(400).json({ ok: false, error: error?.message || "Falha ao processar webhook." });
  }
});

router.post("/:provider/webhook", (_req, res) => {
  res.status(400).json({
    ok: false,
    error: "Informe o ID da integracao no caminho do webhook.",
  });
});

module.exports = router;
