"use strict";

const { env } = require("../../config/env");

function assertMetaOAuthConfigured() {
  const missing = [];
  if (!env.metaAppId) missing.push("META_APP_ID");
  if (!env.metaAppSecret) missing.push("META_APP_SECRET");
  if (!env.metaRedirectUri) missing.push("META_REDIRECT_URI");
  if (missing.length) {
    const error = new Error(`Meta OAuth is not configured: ${missing.join(", ")}`);
    error.code = "META_OAUTH_NOT_CONFIGURED";
    error.missing = missing;
    throw error;
  }
}

function graphUrl(pathname, params = {}) {
  const base = `https://graph.facebook.com/${env.metaGraphApiVersion}`;
  const raw = String(pathname || "");
  const url = new URL(raw.startsWith("http") ? raw : `${base}/${raw.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function buildAuthorizationUrl(state) {
  assertMetaOAuthConfigured();
  const url = new URL(`https://www.facebook.com/${env.metaGraphApiVersion}/dialog/oauth`);
  url.searchParams.set("client_id", env.metaAppId);
  url.searchParams.set("redirect_uri", env.metaRedirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", env.metaOAuthScopes);
  return url.toString();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const error = new Error(payload.error?.message || payload.error_description || `Meta HTTP ${response.status}`);
    error.code = payload.error?.code ? `META_${payload.error.code}` : "META_HTTP_ERROR";
    error.meta = payload.error || payload;
    throw error;
  }
  return payload;
}

async function exchangeAuthorizationCode(code) {
  assertMetaOAuthConfigured();
  const url = graphUrl("oauth/access_token", {
    client_id: env.metaAppId,
    client_secret: env.metaAppSecret,
    redirect_uri: env.metaRedirectUri,
    code,
  });
  const shortLived = await fetchJson(url);
  if (!shortLived.access_token) {
    const error = new Error("Meta OAuth did not return an access token");
    error.code = "META_ACCESS_TOKEN_MISSING";
    throw error;
  }

  const longUrl = graphUrl("oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: env.metaAppId,
    client_secret: env.metaAppSecret,
    fb_exchange_token: shortLived.access_token,
  });
  try {
    const longLived = await fetchJson(longUrl);
    return { ...shortLived, ...longLived };
  } catch (error) {
    console.warn("[dach-ads:meta] long-lived token exchange failed; using original token", error.message);
    return shortLived;
  }
}

async function debugToken(accessToken) {
  assertMetaOAuthConfigured();
  const url = graphUrl("debug_token", {
    input_token: accessToken,
    access_token: `${env.metaAppId}|${env.metaAppSecret}`,
  });
  const payload = await fetchJson(url);
  return payload.data || {};
}

async function fetchUserProfile(accessToken) {
  const url = graphUrl("me", { fields: "id,name,email", access_token: accessToken });
  return fetchJson(url);
}

function tokenExpiryDate(expiresIn, debug = {}) {
  if (debug.expires_at) return new Date(Number(debug.expires_at) * 1000);
  const seconds = Number(expiresIn || 0);
  return seconds > 0 ? new Date(Date.now() + seconds * 1000) : null;
}

async function revokePermissions(accessToken) {
  const url = graphUrl("me/permissions", { access_token: accessToken });
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error?.message || `Meta revoke HTTP ${response.status}`);
    error.code = "META_REVOKE_FAILED";
    throw error;
  }
}

module.exports = {
  assertMetaOAuthConfigured,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  debugToken,
  fetchUserProfile,
  tokenExpiryDate,
  revokePermissions,
};
