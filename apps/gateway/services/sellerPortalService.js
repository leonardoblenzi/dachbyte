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
