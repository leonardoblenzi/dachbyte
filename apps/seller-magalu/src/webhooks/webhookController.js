"use strict";

const env = require("../config/env");
const webhookRepository = require("../repositories/webhookRepository");
const { enqueueWebhookEvent } = require("../queues/magaluQueue");
const { isTimestampFresh, verifySignature, eventHash } = require("./signature");

async function receiveV1Webhook(req, res, next) {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
    const signatureHeader = String(req.headers["x-signature-256"] || "").trim();
    const timestamp = String(req.headers["x-timestamp"] || "").trim();

    if (!signatureHeader || !timestamp || !rawBody.length) {
      return res.status(400).json({ ok: false, error: "missing_webhook_security_headers" });
    }
    if (!isTimestampFresh(timestamp, env.MAGALU_WEBHOOK_MAX_SKEW_SECONDS)) {
      return res.status(401).json({ ok: false, error: "webhook_timestamp_outside_window" });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch (_error) {
      return res.status(400).json({ ok: false, error: "invalid_json" });
    }

    const tenantId = String(payload?.tenant_id || "").trim();
    const topic = String(payload?.topic || "").trim();
    if (!tenantId || !topic) {
      return res.status(400).json({ ok: false, error: "invalid_webhook_envelope" });
    }

    // O envelope ainda é não confiável neste ponto e é usado apenas para localizar
    // o segredo candidato. Nenhum evento é persistido/enfileirado antes do HMAC.
    const secretRows = await webhookRepository.findSubscriptionSecrets({ tenantId, topic });
    if (!secretRows.length) {
      return res.status(401).json({ ok: false, error: "webhook_subscription_not_found" });
    }
    const valid = verifySignature({
      rawBody,
      signatureHeader,
      timestamp,
      secrets: secretRows.map((row) => row.secret),
    });
    if (!valid) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_signature" });
    }

    const hash = eventHash({ rawBody, timestamp, tenantId, topic });
    const event = await webhookRepository.insertValidatedEvent({
      tenantId,
      topic,
      payload,
      rawBody: rawBody.toString("utf8"),
      eventHash: hash,
      signature: signatureHeader,
      timestamp,
    });

    if (!event?.id) {
      return res.status(500).json({ ok: false, error: "webhook_event_persistence_failed" });
    }

    // Se a persistência ocorreu, mas o Redis falhou, o evento permanece
    // 'validated'. Uma nova entrega do mesmo webhook pode reenfileirá-lo sem
    // duplicar a linha do banco. Jobs usam ID determinístico no BullMQ.
    if (["validated", "failed"].includes(event.processing_status)) {
      await enqueueWebhookEvent(event.id);
      await webhookRepository.markEventQueued(event.id);
    }
    return res.status(202).json({ ok: true, duplicate: event.inserted !== true });
  } catch (error) {
    return next(error);
  }
}

module.exports = { receiveV1Webhook };
