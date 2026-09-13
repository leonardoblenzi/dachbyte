"use strict";

const db = require("../../../db/db");
const logger = require("../../observability/logger");
const { setRequestContext } = require("../../observability/requestContext");
const { integrationError, normalizeProvider } = require("./helpers");
const { ingestWebhook } = require("./webhookService");

const adapters = new Map();

function registerWebhookAdapter(provider, adapter) {
  const key = normalizeProvider(provider);
  if (!adapter || typeof adapter.verify !== "function" || typeof adapter.resolveAccount !== "function" || typeof adapter.normalize !== "function") {
    throw new Error("Webhook adapter exige verify, resolveAccount e normalize.");
  }
  adapters.set(key, adapter);
  return () => adapters.delete(key);
}

function getWebhookAdapter(provider) {
  return adapters.get(normalizeProvider(provider)) || null;
}

async function processIncomingWebhook(provider, request) {
  const key = normalizeProvider(provider);
  const adapter = adapters.get(key);
  if (!adapter) throw integrationError("Provedor de webhook nao registrado.", "WEBHOOK_PROVIDER_NOT_REGISTERED", { retryable: false, statusCode: 404 });
  // Identification may inspect untrusted account/seller identifiers, but it does
  // not establish tenant context. Signature verification happens before tenant entry.
  const account = await adapter.resolveAccount(request);
  const companyId = String(account?.companyId || "").trim();
  const accountId = String(account?.accountId || account?.id || "").trim() || null;
  if (!companyId) throw integrationError("Webhook sem tenant resolvido.", "WEBHOOK_TENANT_UNRESOLVED", { retryable: false, statusCode: 422 });
  const verified = await adapter.verify(request, account);
  if (verified !== true) throw integrationError("Assinatura do webhook invalida.", "WEBHOOK_SIGNATURE_INVALID", { retryable: false, statusCode: 401 });
  setRequestContext({ companyId });
  const normalized = await adapter.normalize(request, account);
  const result = await db.withTenantContext(companyId, () => ingestWebhook(companyId, {
    ...normalized,
    provider: key,
    accountId,
    headers: request.headers,
  }));
  logger.info(result.duplicate ? "integration.webhook.duplicate" : "integration.webhook.accepted", {
    companyId,
    provider: key,
    accountId,
    externalEventId: normalized.externalEventId,
    eventType: normalized.eventType,
    jobId: result.job?.id,
  });
  return result;
}

module.exports = { getWebhookAdapter, processIncomingWebhook, registerWebhookAdapter };
