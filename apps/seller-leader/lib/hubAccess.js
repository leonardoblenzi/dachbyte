"use strict";

const HUB_DISABLED_VALUES = new Set([
  "",
  "0",
  "false",
  "null",
  "undefined",
  "off",
  "none",
  "disabled",
  "(not set)",
]);
const HUB_BILLING_ALLOW_TTL_MS = 24 * 60 * 60 * 1000;
const HUB_BILLING_NEAR_EXPIRATION_TTL_MS = 60 * 60 * 1000;
const HUB_BILLING_DENY_TTL_MS = 5 * 60 * 1000;
const HUB_BILLING_NEAR_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;
const hubBillingCache = new Map();

function normalizeHubConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  return HUB_DISABLED_VALUES.has(value.toLowerCase()) ? "" : value;
}

function getHubConfig() {
  return {
    baseUrl: normalizeHubConfigValue(process.env.HUB_BASE_URL).replace(/\/+$/, ""),
    token: normalizeHubConfigValue(process.env.HUB_INTERNAL_TOKEN),
  };
}

function isHubConfigured() {
  const config = getHubConfig();
  return Boolean(config.baseUrl && config.token);
}

function getHubBillingCacheKey(identity) {
  return [
    String(identity?.tenantGlobalId || "").trim(),
    String(identity?.userGlobalId || "").trim(),
    "skuleader",
  ].join(":");
}

function parseHubAccessExpiration(payload) {
  const raw = payload?.expires_at || payload?.ends_at || payload?.expiresAt || null;
  if (!raw) return null;
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? time : null;
}

function getHubBillingCacheTtl(result) {
  if (!result?.allow) return HUB_BILLING_DENY_TTL_MS;
  const expiresAt = parseHubAccessExpiration(result.payload);
  const now = Date.now();
  if (expiresAt && expiresAt <= now) return 0;
  const baseTtl =
    expiresAt && expiresAt - now <= HUB_BILLING_NEAR_EXPIRATION_MS
      ? HUB_BILLING_NEAR_EXPIRATION_TTL_MS
      : HUB_BILLING_ALLOW_TTL_MS;
  return expiresAt ? Math.max(0, Math.min(baseTtl, expiresAt - now)) : baseTtl;
}

function readFreshHubBillingCache(cacheKey) {
  const entry = hubBillingCache.get(cacheKey);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return { ...entry.result, cached: true };
}

function readStaleAllowedHubBillingCache(cacheKey) {
  const entry = hubBillingCache.get(cacheKey);
  if (!entry?.result?.allow) return null;
  if (entry.subscriptionExpiresAt && entry.subscriptionExpiresAt <= Date.now()) return null;
  return { ...entry.result, cached: true, stale: true };
}

function writeHubBillingCache(cacheKey, result) {
  const ttl = getHubBillingCacheTtl(result);
  if (ttl <= 0) {
    hubBillingCache.delete(cacheKey);
    return;
  }
  hubBillingCache.set(cacheKey, {
    result,
    expiresAt: Date.now() + ttl,
    subscriptionExpiresAt: parseHubAccessExpiration(result.payload),
  });
}

async function checkSkuLeaderAccess(identity, action = "login") {
  if (!isHubConfigured()) {
    return { allow: true, skipped: true, reason: "hub_not_configured" };
  }

  const tenantId = String(identity?.tenantGlobalId || "").trim();
  const userId = String(identity?.userGlobalId || "").trim();
  if (!tenantId || !userId) {
    return { allow: false, reason: "hub_identity_missing" };
  }

  const shouldUseCache = String(action || "").toLowerCase() !== "login";
  const cacheKey = getHubBillingCacheKey(identity);
  if (shouldUseCache) {
    const cachedAccess = readFreshHubBillingCache(cacheKey);
    if (cachedAccess) return cachedAccess;
  }

  const config = getHubConfig();
  try {
    const response = await fetch(`${config.baseUrl}/v1/access/check`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        tenant_id: tenantId,
        user_id: userId,
        module: "skuleader",
        action,
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const staleAccess = shouldUseCache ? readStaleAllowedHubBillingCache(cacheKey) : null;
      if (staleAccess) return staleAccess;
      if (response.status === 401 || response.status === 403) {
        console.warn("[SKU Tracker] Hub retornou auth invalida; bypass temporario aplicado.");
        return { allow: true, skipped: true, reason: "hub_auth_invalid" };
      }
      return shouldUseCache
        ? { allow: true, reason: "hub_access_check_failed_soft_allow" }
        : {
            allow: false,
            reason: payload?.error || "hub_access_check_failed",
            status_code: response.status,
          };
    }

    const result = {
      ...payload,
      payload,
      allow: Boolean(payload?.allow),
      reason: payload?.reason || (payload?.allow ? "ok" : "module_not_allowed"),
    };

    if (shouldUseCache) writeHubBillingCache(cacheKey, result);
    return result;
  } catch (error) {
    const staleAccess = shouldUseCache ? readStaleAllowedHubBillingCache(cacheKey) : null;
    if (staleAccess) return staleAccess;
    return shouldUseCache
      ? { allow: true, reason: "hub_access_check_failed_soft_allow" }
      : { allow: false, reason: "hub_access_check_failed", detail: error?.message || String(error) };
  }
}

async function verifySkuLeaderGlobalLogin({ email, password }) {
  if (!isHubConfigured()) {
    return { allow: false, skipped: true, reason: "hub_not_configured" };
  }

  const config = getHubConfig();
  const response = await fetch(`${config.baseUrl}/v1/internal/auth/verify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({
      email,
      password,
      module: "skuleader",
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      allow: false,
      reason: payload?.reason || payload?.error || `hub_auth_${response.status}`,
    };
  }

  return payload?.allow
    ? { allow: true, payload }
    : { allow: false, reason: payload?.reason || "hub_denied" };
}

module.exports = {
  checkSkuLeaderAccess,
  isHubConfigured,
  verifySkuLeaderGlobalLogin,
};
