"use strict";

const env = require("../config/env");

function normalizedScopes(scopes) {
  return Array.from(new Set((Array.isArray(scopes) ? scopes : []).map((scope) => String(scope || "").trim()).filter(Boolean)));
}

function localResourceKey(account) {
  const accountId = String(account?.magalu_tenant_id || "").trim();
  if (!accountId) throw new Error("Conta Magalu sem tenant para chave de recurso Hub.");
  return `magalu:${accountId}`;
}

function buildHubResourcePayload(account) {
  const tenantId = String(account?.dach_tenant_id || "").trim();
  const accountId = String(account?.magalu_tenant_id || "").trim();
  const localAccountId = Number(account?.id);
  if (!tenantId || !accountId || !Number.isFinite(localAccountId) || localAccountId <= 0) {
    throw new Error("Conta Magalu inválida para sincronização de recurso no Hub.");
  }
  return {
    tenant_id: tenantId,
    module_slug: "magalu",
    account_id: accountId,
    label: String(account?.magalu_tenant_name || accountId).trim() || accountId,
    metadata: { provider: "magalu", local_account_id: localAccountId, scopes: normalizedScopes(account.scopes) },
  };
}

async function syncHubResource(account) {
  if (!env.HUB_BASE_URL || !env.HUB_INTERNAL_TOKEN) throw new Error("Hub interno não configurado para sincronização de recurso Magalu.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, env.HUB_REQUEST_TIMEOUT_MS));
  try {
    const response = await fetch(`${env.HUB_BASE_URL}/v1/internal/resources/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.HUB_INTERNAL_TOKEN}` },
      body: JSON.stringify(buildHubResourcePayload(account)),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Hub resource sync failed (HTTP ${response.status}).`);
    return { resourceKey: localResourceKey(account) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { syncHubResource, _test: { buildHubResourcePayload, normalizedScopes, localResourceKey } };
