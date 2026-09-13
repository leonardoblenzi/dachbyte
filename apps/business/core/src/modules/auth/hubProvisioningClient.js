"use strict";

const MODULE_KEY = "volt_core";

function configurationError() {
  return Object.assign(new Error("A integracao central de acesso nao esta disponivel. Tente novamente em instantes."), {
    statusCode: 503,
    code: "HUB_PROVISIONING_UNAVAILABLE",
  });
}

function requestError(status) {
  return Object.assign(new Error("Nao foi possivel concluir a sincronizacao de acesso. Tente novamente."), {
    statusCode: status === 409 ? 409 : 502,
    code: "HUB_PROVISIONING_FAILED",
  });
}

function hubConfig() {
  const baseUrl = String(process.env.HUB_BASE_URL || "").trim().replace(/\/+$/, "");
  const token = String(process.env.HUB_INTERNAL_TOKEN || "").trim();
  if (!baseUrl || !token || typeof fetch !== "function") throw configurationError();
  return { baseUrl, token };
}

async function postHub(path, payload) {
  const { baseUrl, token } = hubConfig();
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      signal: AbortSignal.timeout(Math.max(1_000, Number(process.env.HUB_REQUEST_TIMEOUT_MS || 8_000))),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok !== true) throw requestError(response.status);
    return body;
  } catch (error) {
    if (error?.code === "HUB_PROVISIONING_FAILED") throw error;
    if (error?.code === "HUB_PROVISIONING_UNAVAILABLE") throw error;
    throw requestError(0);
  }
}

async function provisionVoltCoreCompany(input = {}) {
  const result = await postHub("/v1/internal/identity/company", {
    idempotency_key: String(input.idempotencyKey || "").trim(),
    company_name: String(input.companyName || "").trim(),
    document_type: String(input.documentType || "").trim() || undefined,
    document_number: String(input.documentNumber || "").trim() || undefined,
    module: MODULE_KEY,
  });
  const tenantId = String(result.tenant_id || "").trim();
  if (!tenantId) throw requestError(502);
  return { tenantId, productKey: String(result.product_key || MODULE_KEY), productStatus: String(result.product_status || "active") };
}

async function provisionVoltCoreUser(input = {}) {
  const result = await postHub("/v1/internal/identity/sync", {
    tenant_id: String(input.tenantId || "").trim(),
    company_name: String(input.companyName || "").trim(),
    document_type: String(input.documentType || "").trim() || undefined,
    document_number: String(input.documentNumber || "").trim() || undefined,
    user_id: String(input.userId || "").trim(),
    full_name: String(input.fullName || "").trim(),
    email: String(input.email || "").trim().toLowerCase(),
    role: String(input.role || "operator").trim(),
    module: MODULE_KEY,
    modules: [MODULE_KEY],
    access_policy: "explicit",
    invite: true,
    origin_module: MODULE_KEY,
  });
  const userId = String(result.user_id || "").trim();
  if (!userId) throw requestError(502);
  return { tenantId: String(result.tenant_id || "").trim(), userId, inviteUrl: String(result.invite_url || "").trim() || null };
}

module.exports = {
  provisionVoltCoreCompany,
  provisionVoltCoreUser,
};
