"use strict";

async function activateShopeeTrialInHub(input, options = {}) {
  const tenantId = String(input.tenantId || "").trim();
  const companyName = String(input.companyName || "").trim();
  const userId = String(input.userId || "").trim();
  const fullName = String(input.fullName || "").trim();
  const email = String(input.email || "").trim().toLowerCase();
  const shopId = String(input.shopId || "").trim();
  if (!tenantId || !companyName || !userId || !fullName || !email || !/^\d+$/.test(shopId)) {
    throw new Error("trial_hub_identity_invalid");
  }
  const baseUrl = String(options.baseUrl ?? process.env.HUB_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(options.token ?? process.env.HUB_INTERNAL_TOKEN ?? "").trim();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!baseUrl || !token || typeof fetchImpl !== "function") throw new Error("trial_hub_unavailable");
  const post = async (path, body, failureCode) => {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
    } catch (_error) { throw new Error(failureCode); }
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(failureCode);
    return payload;
  };
  const identity = {
    tenant_id: tenantId, company_name: companyName,
    user_id: userId, full_name: fullName, email,
    role: input.role || "owner", module: "shopee", modules: ["shopee"],
    access_policy: "explicit", reject_email_conflict: input.newIdentity === true,
    trial_prepare_identity: true,
  };
  const prepared = await post("/v1/internal/identity/sync", identity, "trial_hub_identity_sync_failed");
  if (prepared?.ok !== true || prepared.tenant_id !== tenantId || prepared.user_id !== userId) {
    throw new Error("trial_hub_identity_mismatch");
  }
  const resourceKey = `shopee:${shopId}`;
  const activation = await post("/v1/internal/portal/module-trials/activate", {
    tenant_id: tenantId, module_slug: "shopee", resource_key: resourceKey,
  }, "trial_hub_resource_activation_failed");
  if (activation?.resource?.resource_key !== resourceKey || !activation?.trial?.endsAt) {
    throw new Error("trial_hub_resource_activation_failed");
  }
  const granted = await post("/v1/internal/identity/sync", {
    ...identity, trial_prepare_identity: false,
  }, "trial_hub_module_access_failed");
  if (granted?.ok !== true || granted.tenant_id !== tenantId || granted.user_id !== userId) {
    throw new Error("trial_hub_module_access_failed");
  }
  return activation;
}

module.exports = { activateShopeeTrialInHub };
