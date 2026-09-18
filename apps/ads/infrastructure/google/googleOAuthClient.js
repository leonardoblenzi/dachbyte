"use strict";

const { env } = require("../../config/env");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/adwords",
];

function assertGoogleOAuthConfigured() {
  const missing = [];
  if (!env.googleAdsClientId) missing.push("GOOGLE_ADS_CLIENT_ID");
  if (!env.googleAdsClientSecret) missing.push("GOOGLE_ADS_CLIENT_SECRET");
  if (!env.googleAdsRedirectUri) missing.push("GOOGLE_ADS_REDIRECT_URI");
  if (missing.length) {
    const error = new Error(`Google Ads OAuth is not configured: ${missing.join(", ")}`);
    error.code = "GOOGLE_ADS_OAUTH_NOT_CONFIGURED";
    error.missing = missing;
    throw error;
  }
}

function buildAuthorizationUrl(state) {
  assertGoogleOAuthConfigured();
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", env.googleAdsClientId);
  url.searchParams.set("redirect_uri", env.googleAdsRedirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent select_account");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

async function postForm(url, values) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error_description || payload.error || `Google OAuth HTTP ${response.status}`);
      error.code = payload.error || "GOOGLE_OAUTH_HTTP_ERROR";
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function exchangeAuthorizationCode(code) {
  assertGoogleOAuthConfigured();
  return postForm(TOKEN_URL, {
    code,
    client_id: env.googleAdsClientId,
    client_secret: env.googleAdsClientSecret,
    redirect_uri: env.googleAdsRedirectUri,
    grant_type: "authorization_code",
  });
}

async function refreshAccessToken(refreshToken) {
  assertGoogleOAuthConfigured();
  return postForm(TOKEN_URL, {
    refresh_token: refreshToken,
    client_id: env.googleAdsClientId,
    client_secret: env.googleAdsClientSecret,
    grant_type: "refresh_token",
  });
}

async function fetchUserInfo(accessToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error_description || payload.error || `Google userinfo HTTP ${response.status}`);
      error.code = "GOOGLE_USERINFO_FAILED";
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function revokeToken(token) {
  if (!token) return;
  await postForm(REVOKE_URL, { token }).catch((error) => {
    console.warn("[dach-ads:google] token revoke failed", error.message);
  });
}

function tokenExpiryDate(expiresInSeconds) {
  const seconds = Number(expiresInSeconds || 3600);
  return new Date(Date.now() + Math.max(60, seconds) * 1000);
}

module.exports = {
  SCOPES,
  assertGoogleOAuthConfigured,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  fetchUserInfo,
  revokeToken,
  tokenExpiryDate,
};
