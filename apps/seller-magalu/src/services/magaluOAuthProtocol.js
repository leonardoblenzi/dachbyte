"use strict";

const env = require("../config/env");
const {
  extractTenantSubject,
  parseScopes,
  resolveAccessExpiry,
  resolveRefreshExpiry,
} = require("./oauthSecurity");

function text(value) {
  return String(value == null ? "" : value).trim();
}

function oauthConfigured() {
  return Boolean(env.MAGALU_OAUTH_CLIENT_ID && env.MAGALU_OAUTH_CLIENT_SECRET && env.MAGALU_OAUTH_REDIRECT_URI);
}

function assertOAuthConfigured() {
  if (!oauthConfigured()) {
    const error = new Error("OAuth Magalu não configurado. Preencha client ID, client secret e redirect URI.");
    error.code = "MAGALU_OAUTH_NOT_CONFIGURED";
    error.status = 503;
    throw error;
  }
}

function publicOAuthConfig() {
  return {
    configured: oauthConfigured(),
    redirect_uri: env.MAGALU_OAUTH_REDIRECT_URI || null,
    scopes: [...env.MAGALU_OAUTH_SCOPES],
    choose_tenants: true,
  };
}

function buildConsentUrl({ state, scopes = env.MAGALU_OAUTH_SCOPES } = {}) {
  assertOAuthConfigured();
  const normalizedState = text(state);
  if (!normalizedState) throw new Error("OAuth state é obrigatório.");
  const url = new URL(env.MAGALU_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", env.MAGALU_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.MAGALU_OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", parseScopes(scopes).join(" "));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("choose_tenants", "true");
  url.searchParams.set("state", normalizedState);
  return url.toString();
}

async function postTokenRequest({ body, contentType }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(env.MAGALU_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": contentType,
      },
      body,
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch (_error) { payload = { raw_response: raw }; }
    if (!response.ok) {
      const error = new Error(
        payload?.error_description || payload?.message || payload?.error || `ID Magalu HTTP ${response.status}`,
      );
      error.code = payload?.error || "MAGALU_OAUTH_TOKEN_ERROR";
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeout = new Error("Tempo esgotado ao comunicar com o ID Magalu.");
      timeout.code = "MAGALU_OAUTH_TIMEOUT";
      timeout.status = 504;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function exchangeAuthorizationCode(code) {
  assertOAuthConfigured();
  const normalizedCode = text(code);
  if (!normalizedCode) {
    const error = new Error("Código de autorização Magalu ausente.");
    error.code = "MAGALU_OAUTH_CODE_MISSING";
    error.status = 400;
    throw error;
  }
  return postTokenRequest({
    contentType: "application/json",
    body: JSON.stringify({
      client_id: env.MAGALU_OAUTH_CLIENT_ID,
      client_secret: env.MAGALU_OAUTH_CLIENT_SECRET,
      redirect_uri: env.MAGALU_OAUTH_REDIRECT_URI,
      code: normalizedCode,
      grant_type: "authorization_code",
    }),
  });
}

async function refreshTokenGrant(refreshToken) {
  assertOAuthConfigured();
  const normalized = text(refreshToken);
  if (!normalized) {
    const error = new Error("Refresh token Magalu ausente.");
    error.code = "MAGALU_REFRESH_TOKEN_MISSING";
    error.status = 409;
    throw error;
  }
  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("client_id", env.MAGALU_OAUTH_CLIENT_ID);
  form.set("client_secret", env.MAGALU_OAUTH_CLIENT_SECRET);
  form.set("refresh_token", normalized);
  return postTokenRequest({
    contentType: "application/x-www-form-urlencoded",
    body: form.toString(),
  });
}

function normalizeTokenSet(tokenResponse, fallbackRefreshToken = null) {
  const accessToken = text(tokenResponse?.access_token);
  const refreshToken = text(tokenResponse?.refresh_token || fallbackRefreshToken);
  if (!accessToken || !refreshToken) {
    const error = new Error("O ID Magalu não retornou access_token e refresh_token válidos.");
    error.code = "MAGALU_TOKEN_SET_INCOMPLETE";
    error.status = 502;
    throw error;
  }
  const { subject, payload } = extractTenantSubject(accessToken);
  return {
    subject,
    accessClaims: payload || {},
    accessToken,
    refreshToken,
    tokenType: text(tokenResponse?.token_type || "Bearer") || "Bearer",
    scopes: parseScopes(tokenResponse?.scope),
    accessExpiresAt: resolveAccessExpiry(tokenResponse, accessToken),
    refreshExpiresAt: resolveRefreshExpiry(refreshToken),
    refreshedAt: new Date(),
    createdAt: tokenResponse?.created_at || null,
  };
}

module.exports = {
  oauthConfigured,
  publicOAuthConfig,
  buildConsentUrl,
  exchangeAuthorizationCode,
  refreshTokenGrant,
  normalizeTokenSet,
};
