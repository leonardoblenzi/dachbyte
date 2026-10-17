"use strict";

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeIdentity(identity = {}) {
  return {
    tenant_id: String(identity.tenant_id || "").trim(),
    user_id: String(identity.user_id || "").trim(),
  };
}

const PLATFORM_SELLER_MODULES = [
  { slug: "ml", name: "Mercado Livre" },
  { slug: "shopee", name: "Shopee" },
  { slug: "magalu", name: "Magalu" },
  { slug: "tracking", name: "Tracking" },
  { slug: "davanttilog", name: "DACHBYTE Log" },
  { slug: "madeira", name: "Madeira" },
  { slug: "skuleader", name: "SKU Tracker" },
];

function isPlatformMaster(identity, resolved) {
  return resolved.tenant_id === `platform-${resolved.user_id}` &&
    identity?.subscription?.is_master === true;
}

function createSellerPortalService({ baseUrl, internalToken, fetchImpl = fetch }) {
  const hubBaseUrl = normalizeBaseUrl(baseUrl);
  const token = String(internalToken || "").trim();

  async function post(path, body) {
    if (!hubBaseUrl || !token) {
      return {
        ok: false,
        status: 503,
        payload: { ok: false, error: "hub_not_configured" },
      };
    }

    try {
      const response = await fetchImpl(`${hubBaseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body || {}),
      });
      const payload = await response.json().catch(() => ({}));
      return { ok: response.ok, status: response.status, payload };
    } catch (error) {
      return {
        ok: false,
        status: 503,
        payload: {
          ok: false,
          error: "hub_unavailable",
          detail: error?.message || String(error),
        },
      };
    }
  }

  return {
    async overview(identity) {
      const resolved = normalizeIdentity(identity);
      if (!resolved.tenant_id || !resolved.user_id) {
        return {
          ok: false,
          status: 401,
          payload: { ok: false, error: "suite_identity_incomplete" },
        };
      }
      if (isPlatformMaster(identity, resolved)) {
        const checks = await Promise.all(PLATFORM_SELLER_MODULES.map(async (module) => ({
          module,
          result: await post("/v1/access/check", {
            ...resolved,
            module: module.slug,
            action: "PORTAL_OVERVIEW",
          }),
        })));
        const failed = checks.find(({ result }) => !result.ok);
        if (failed) return failed.result;
        const allowed = checks
          .filter(({ result }) => result.payload?.allow === true)
          .map(({ module }) => ({
            slug: module.slug,
            name: module.name,
            installed: true,
            user_allowed: true,
            resource_required: false,
            status: "active",
            can_enter: true,
            can_purchase: false,
            can_manage: false,
            accounts: { total: 0, active: 0, expiring: 0, expired: 0, inactive: 0 },
            resources: [],
            catalog_plans: [],
          }));
        return {
          ok: true,
          status: 200,
          payload: {
            ok: true,
            platform_operator: true,
            tenant: { tenant_id: resolved.tenant_id, name: "DACHBYTE Seller", access_state: "active" },
            user: {
              user_id: resolved.user_id,
              name: String(identity.name || identity.email || "Usuário").trim(),
              email: String(identity.email || "").trim(),
              role: "master",
              can_manage_billing: false,
            },
            billing: { profile_complete: false, profile: {} },
            modules: allowed,
            alerts: [],
            summary: {
              installed_modules: allowed.length,
              available_modules: 0,
              total_accounts: 0,
              active_accounts: 0,
              expiring_accounts: 0,
              expired_accounts: 0,
            },
          },
        };
      }
      return post("/v1/internal/portal/overview", resolved);
    },

    async checkout(identity, input = {}) {
      const resolved = normalizeIdentity(identity);
      if (!resolved.tenant_id || !resolved.user_id) {
        return {
          ok: false,
          status: 401,
          payload: { ok: false, error: "suite_identity_incomplete" },
        };
      }
      return post("/v1/internal/portal/checkout", {
        ...input,
        tenant_id: resolved.tenant_id,
        user_id: resolved.user_id,
      });
    },

    async unlinkAccount(identity, input = {}) {
      const resolved = normalizeIdentity(identity);
      if (!resolved.tenant_id || !resolved.user_id) {
        return {
          ok: false,
          status: 401,
          payload: { ok: false, error: "suite_identity_incomplete" },
        };
      }
      return post("/v1/internal/portal/accounts/unlink", {
        ...input,
        tenant_id: resolved.tenant_id,
        user_id: resolved.user_id,
      });
    },

    async renewalIntent(identity, resourceKeys) {
      const resolved = normalizeIdentity(identity);
      if (!resolved.tenant_id || !resolved.user_id) {
        return {
          ok: false,
          status: 401,
          payload: { ok: false, error: "suite_identity_incomplete" },
        };
      }
      return post("/v1/internal/portal/renewal-intent", {
        tenant_id: resolved.tenant_id,
        user_id: resolved.user_id,
        resource_keys: Array.isArray(resourceKeys) ? resourceKeys : [],
      });
    },
  };
}

module.exports = { createSellerPortalService };
