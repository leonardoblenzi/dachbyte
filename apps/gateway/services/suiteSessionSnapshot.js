"use strict";

function normalizedStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
}

function deniedSnapshot(code) {
  return { ok: false, logged: true, code: String(code || "hub_access_denied") };
}

function createSuiteSessionSnapshotService({ baseUrl, internalToken, fetchImpl = fetch }) {
  const hubBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
  const token = String(internalToken || "").trim();

  return {
    async resolve(identity = {}) {
      const tenantId = String(identity.tenant_id || "").trim();
      const userId = String(identity.user_id || "").trim();
      if (!hubBaseUrl || !token) return deniedSnapshot("hub_not_configured");
      if (!tenantId || !userId) return deniedSnapshot("suite_identity_incomplete");

      let response;
      let access;
      try {
        response = await fetchImpl(`${hubBaseUrl}/v1/access/check`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            tenant_id: tenantId,
            user_id: userId,
            module: "suite",
            action: "SESSION",
          }),
        });
        access = await response.json().catch(() => ({}));
      } catch (_error) {
        return deniedSnapshot("hub_unavailable");
      }

      if (!response.ok || access?.allow !== true) {
        return deniedSnapshot(access?.reason || access?.error || "hub_access_denied");
      }

      const sellerModules = normalizedStrings(access?.seller_modules);
      const policyIsActive = access?.allow === true && String(access?.status || "").trim().toLowerCase() === "active";
      return {
        ok: true,
        logged: true,
        user: {
          name: String(access?.name || identity.nome || identity.name || identity.email || "Usuário").trim(),
          email: String(access?.email || identity.email || "").trim(),
        },
        entitlements: {
          modules: sellerModules,
          seller_modules: sellerModules,
        },
        subscription: {
          status: String(access?.subscription_status || (policyIsActive ? "active" : "inactive")).trim(),
          active: access?.subscription_active === true || policyIsActive,
          expires_at: access?.expires_at || null,
          days_until_expiration: access?.days_until_expiration ?? null,
          renewal_url: access?.renewal_url || null,
          renewable_resources: Array.isArray(access?.renewable_resources) ? access.renewable_resources : [],
        },
      };
    },
  };
}

module.exports = { createSuiteSessionSnapshotService };
