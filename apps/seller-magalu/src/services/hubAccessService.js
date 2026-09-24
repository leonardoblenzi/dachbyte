"use strict";

const env = require("../config/env");

const cache = new Map();
const CACHE_TTL_MS = 45 * 1000;
const DEFAULT_ACTION = "ACCESS magalu";

function cacheKey(identity, action = DEFAULT_ACTION, resourceKey = "") {
  const resource = String(resourceKey || "").trim();
  const base = `${identity.dachTenantId}:${identity.dachUserId}:magalu:${String(action || DEFAULT_ACTION)}`;
  return resource ? `${base}:${resource}` : base;
}

function isStrict() {
  return !["off", "disabled", "monitor", "soft"].includes(env.MAGALU_HUB_GATE_MODE);
}

async function checkHubAccess(identity, options = {}) {
  const action = String(options.action || DEFAULT_ACTION).trim() || DEFAULT_ACTION;
  const resourceKey = String(options.resourceKey || "").trim();
  const force = options.force === true;
  const key = cacheKey(identity, action, resourceKey);
  const current = cache.get(key);
  if (!force && current && current.expiresAt > Date.now()) {
    return { ...current.value, cached: true };
  }

  if (!env.HUB_BASE_URL || !env.HUB_INTERNAL_TOKEN) {
    return isStrict()
      ? { allow: false, reason: "hub_not_configured" }
      : { allow: true, reason: "hub_not_configured_soft_allow" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, env.HUB_REQUEST_TIMEOUT_MS));
  try {
    const response = await fetch(`${env.HUB_BASE_URL}/v1/access/check`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.HUB_INTERNAL_TOKEN}`,
      },
      body: JSON.stringify({
        tenant_id: identity.dachTenantId,
        user_id: identity.dachUserId,
        module: "magalu",
        action,
        ...(resourceKey ? { resource_key: resourceKey } : {}),
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    const value = response.ok && payload?.allow === true
      ? { allow: true, reason: payload.reason || "ok", payload }
      : { allow: false, reason: payload.reason || payload.error || `hub_http_${response.status}`, payload };
    if (!force) cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (error) {
    return isStrict()
      ? { allow: false, reason: error?.name === "AbortError" ? "hub_timeout" : "hub_unavailable" }
      : { allow: true, reason: "hub_unavailable_soft_allow" };
  } finally {
    clearTimeout(timer);
  }
}

function clearHubAccessCache(identity = null) {
  if (!identity) {
    cache.clear();
    return;
  }
  const prefix = `${identity.dachTenantId}:${identity.dachUserId}:magalu:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

module.exports = {
  checkHubAccess,
  clearHubAccessCache,
  _test: { isStrict, cacheKey, DEFAULT_ACTION },
};
