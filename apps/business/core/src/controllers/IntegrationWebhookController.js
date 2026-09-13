"use strict";

const { processIncomingWebhook } = require("../modules/integrations/webhookRegistry");

async function receive(req, res) {
  const result = await processIncomingWebhook(req.params.provider, {
    headers: req.headers,
    body: req.body,
    rawBody: req.rawBody || Buffer.alloc(0),
    query: req.query || {},
    method: req.method,
    path: req.originalUrl,
  });
  return res.status(result.duplicate ? 200 : 202).json({ accepted: true, duplicate: result.duplicate, eventId: result.event?.id });
}

module.exports = { receive };
