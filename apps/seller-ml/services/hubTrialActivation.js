"use strict";

function config(options = {}) {
  const baseUrl = String(options.baseUrl ?? process.env.HUB_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(options.token ?? process.env.HUB_INTERNAL_TOKEN ?? "").trim();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!baseUrl || !token || typeof fetchImpl !== "function") {
    throw new Error("trial_hub_unavailable");
  }
  return { baseUrl, token, fetchImpl };
}

async function postInternal(client, path, body, failureCode) {
  let response;
  try {
    response = await client.fetchImpl(`${client.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${client.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch (_error) {
    throw new Error(failureCode);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = String(payload?.error || "");
    if (failureCode === "trial_hub_identity_sync_failed" &&
        ["cnpj_not_found", "cnpj_lookup_unavailable", "identity_sync_document_invalid", "identity_sync_cnpj_required"].includes(code)) {
      throw new Error(code);
    }
    throw new Error(failureCode);
  }
  return payload;
}

async function activateMlTrialInHub(input, options = {}) {
  const tenantId = String(input.tenantId || "").trim();
  const companyName = String(input.companyName || "").trim();
  const { normalizeCompanyCnpj } = require("../../shared/brazilianDocument");
  const document = input.newIdentity === true
    ? normalizeCompanyCnpj(input.documentNumber) : null;
  const userId = String(input.userId || "").trim();
  const fullName = String(input.fullName || "").trim();
  const email = String(input.email || "").trim().toLowerCase();
  const role = String(input.role || "owner").trim().toLowerCase();
  const rejectEmailConflict = input.newIdentity === true;
  const mlUserId = Number(input.mlUserId);
  if (!tenantId || !companyName || !userId || !fullName || !email ||
      !Number.isSafeInteger(mlUserId) || mlUserId <= 0) {
    throw new Error("trial_hub_identity_invalid");
  }
  if (!["owner", "admin", "operador"].includes(role)) {
    throw new Error("trial_hub_role_invalid");
  }
  const client = config(options);
  const identityPayload = {
    tenant_id: tenantId,
    company_name: companyName,
    ...(document ? { document_type: document.type, document_number: document.number } : {}),
    user_id: userId,
    full_name: fullName,
    email,
    role,
    module: "ml",
    modules: ["ml"],
    access_policy: "explicit",
    reject_email_conflict: rejectEmailConflict,
    trial_prepare_identity: true,
  };
  const identity = await postInternal(client, "/v1/internal/identity/sync", identityPayload,
    "trial_hub_identity_sync_failed");
  if (identity?.ok !== true) throw new Error("trial_hub_identity_sync_failed");
  if (identity.tenant_id !== tenantId || identity.user_id !== userId) {
    throw new Error("trial_hub_identity_mismatch");
  }

  const resourceKey = `ml:${mlUserId}`;
  const activation = await postInternal(client, "/v1/internal/portal/module-trials/activate", {
    tenant_id: tenantId, module_slug: "ml", resource_key: resourceKey
  }, "trial_hub_resource_activation_failed");
  if (!activation?.trial?.endsAt || activation?.resource?.resource_key !== resourceKey) {
    throw new Error("trial_hub_resource_activation_failed");
  }
  const granted = await postInternal(client, "/v1/internal/identity/sync", {
    ...identityPayload, trial_prepare_identity: false,
  }, "trial_hub_module_access_failed");
  if (granted?.ok !== true || granted.tenant_id !== tenantId || granted.user_id !== userId) {
    throw new Error("trial_hub_module_access_failed");
  }
  return activation;
}

module.exports = { activateMlTrialInHub };
