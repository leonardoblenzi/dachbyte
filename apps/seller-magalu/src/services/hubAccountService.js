"use strict";

const env = require("../config/env");

function text(value) {
  return String(value == null ? "" : value).trim();
}

function hubError(message, { status = 503, code = "MAGALU_HUB_REQUEST_FAILED", details = null } = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

async function requestHub(pathname, { method = "POST", body = null } = {}) {
  if (!env.HUB_BASE_URL || !env.HUB_INTERNAL_TOKEN) {
    throw hubError("Hub interno não configurado para o módulo Magalu.", { code: "MAGALU_HUB_NOT_CONFIGURED" });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, env.HUB_REQUEST_TIMEOUT_MS));
  try {
    const response = await fetch(`${env.HUB_BASE_URL}${pathname}`, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${env.HUB_INTERNAL_TOKEN}`,
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw hubError(payload?.message || payload?.error || `Hub respondeu HTTP ${response.status}.`, {
        status: response.status,
        code: text(payload?.error) || "MAGALU_HUB_REQUEST_FAILED",
        details: payload,
      });
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw hubError("Tempo limite ao consultar o Hub.", { code: "MAGALU_HUB_TIMEOUT" });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function unlinkHubResource(account, { reason, actor } = {}) {
  const tenantId = text(account?.dach_tenant_id);
  const accountId = text(account?.magalu_tenant_id);
  if (!tenantId || !accountId) {
    throw hubError("Conta Magalu sem identidade global para desvincular no Hub.", {
      status: 409,
      code: "MAGALU_HUB_RESOURCE_IDENTITY_MISSING",
    });
  }
  return requestHub("/v1/internal/resources/unlink", {
    method: "POST",
    body: {
      tenant_id: tenantId,
      module_slug: "magalu",
      account_id: accountId,
      reason: text(reason) || "Conta Magalu desvinculada pelo usuário.",
      metadata: {
        actor: text(actor) || "magalu_account_unlink",
        local_account_id: Number(account.id) || null,
        label: text(account.magalu_tenant_name) || accountId,
      },
    },
  });
}

module.exports = { unlinkHubResource, _test: { requestHub } };
