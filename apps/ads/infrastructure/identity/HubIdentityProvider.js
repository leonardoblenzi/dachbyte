"use strict";

const jwt = require("jsonwebtoken");
const { env } = require("../../config/env");

function readCookie(header, name) {
  const source = String(header || "");
  for (const part of source.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch (_error) {
      return raw;
    }
  }
  return "";
}

function normalizedArray(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)
    : [];
}

async function checkHubAccess(identity) {
  if (!env.hubBaseUrl || !env.hubInternalToken) {
    return { status: "unavailable", reason: "hub_access_not_configured" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.hubRequestTimeoutMs);
  try {
    const response = await fetch(`${env.hubBaseUrl}/v1/access/check`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.hubInternalToken}`,
      },
      body: JSON.stringify({
        tenant_id: identity.tenantId,
        user_id: identity.userId,
        module: env.hubAdsModule,
        action: "DACH_ADS_ACCESS",
      }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        status: "unavailable",
        reason: payload.reason || payload.error || `hub_access_http_${response.status}`,
      };
    }
    if (payload.allow !== true) {
      return {
        status: "forbidden",
        reason: payload.reason || "dach_ads_not_allowed",
        accessStatus: payload.status || "blocked",
      };
    }
    return {
      status: "authenticated",
      accessStatus: payload.status || "active",
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error?.name === "AbortError" ? "hub_access_timeout" : "hub_access_unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

function createHubIdentityProvider() {
  return Object.freeze({
    async resolve(req) {
      if (!env.suiteJwtSecret) {
        return { status: "unavailable", reason: "suite_jwt_secret_not_configured" };
      }

      const token = readCookie(req?.headers?.cookie, "suite_auth_token");
      if (!token) return { status: "anonymous" };

      let payload;
      try {
        payload = jwt.verify(token, env.suiteJwtSecret, { algorithms: ["HS256"] });
      } catch (_error) {
        return { status: "anonymous" };
      }

      const tenantId = String(payload?.tenant_id || "").trim();
      const userId = String(payload?.user_id || "").trim();
      const email = String(payload?.email || "").trim().toLowerCase() || null;
      const name = String(payload?.name || "").trim() || null;
      if (!tenantId || !userId) return { status: "anonymous" };

      const identity = {
        tenantId,
        userId,
        email,
        name,
        source: "hub",
        sessionModules: normalizedArray(payload?.allowed_modules),
      };
      const access = await checkHubAccess(identity);
      if (access.status !== "authenticated") return access;

      return {
        status: "authenticated",
        identity: {
          ...identity,
          accessStatus: access.accessStatus,
        },
      };
    },
  });
}

module.exports = { createHubIdentityProvider, readCookie };
