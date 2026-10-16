"use strict";

function normalizedStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
}

function deniedSnapshot(code) {
  return { ok: false, logged: true, code: String(code || "hub_access_denied") };
}

const SELLER_MODULES = new Set(["ml", "shopee", "magalu", "tracking", "davanttilog", "madeira", "madeiramadeira", "skuleader"]);

function platformSnapshot(identity = {}) {
  const allowedModules = normalizedStrings(identity.allowed_modules);
  const modules = (allowedModules.length
    ? allowedModules
    : normalizedStrings(identity.visible_modules)
  ).filter((moduleSlug) => SELLER_MODULES.has(moduleSlug));
  const subscription = identity.subscription || {};
  return {
    ok: true,
    logged: true,
    user: {
      name: String(identity.name || identity.nome || identity.email || "Usuário").trim(),
      email: String(identity.email || "").trim(),
    },
    entitlements: {
      modules,
      seller_modules: modules,
    },
    subscription: {
      status: String(subscription.status || "active").trim(),
      active: subscription.active !== false,
      expires_at: subscription.expires_at || null,
      days_until_expiration: subscription.days_until_expiration ?? null,
      renewal_url: subscription.renewal_url || null,
      renewable_resources: Array.isArray(subscription.renewable_resources)
        ? subscription.renewable_resources
        : [],
      is_master: true,
    },
  };
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
      if (tenantId.startsWith("platform-")) return platformSnapshot(identity);

      try {
        const portalResponse = await fetchImpl(`${hubBaseUrl}/v1/internal/portal/overview`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            tenant_id: tenantId,
            user_id: userId,
          }),
        });
        const portal = await portalResponse.json().catch(() => ({}));
        if (portalResponse.ok && portal?.ok) {
          const portalModules = Array.isArray(portal.modules) ? portal.modules : [];
          const visibleModules = normalizedStrings(
            portalModules
              .filter((item) => item && item.installed === true)
              .map((item) => item.slug),
          ).filter((moduleSlug) => SELLER_MODULES.has(moduleSlug));
          const allowedModules = normalizedStrings(
            portalModules
              .filter((item) => item && item.can_enter === true)
              .map((item) => item.slug),
          ).filter((moduleSlug) => SELLER_MODULES.has(moduleSlug));
          return {
            ok: true,
            logged: true,
            user: {
              name: String(portal.user?.name || identity.nome || identity.name || identity.email || "Usuário").trim(),
              email: String(portal.user?.email || identity.email || "").trim(),
            },
            entitlements: {
              modules: allowedModules,
              seller_modules: allowedModules,
              visible_modules: visibleModules,
            },
            subscription: {
              status: allowedModules.length ? "active" : "inactive",
              active: allowedModules.length > 0,
              expires_at: null,
              days_until_expiration: null,
              renewal_url: null,
              renewable_resources: [],
            },
            portal: true,
          };
        }
        if (portalResponse.status !== 404) {
          return deniedSnapshot(portal?.error || portal?.reason || "portal_access_denied");
        }
      } catch (_error) {
        return deniedSnapshot("hub_unavailable");
      }

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
