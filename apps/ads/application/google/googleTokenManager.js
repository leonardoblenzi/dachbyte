"use strict";

const { refreshAccessToken, tokenExpiryDate } = require("../../infrastructure/google/googleOAuthClient");

function needsRefresh(expiresAt) {
  if (!expiresAt) return true;
  const expiry = new Date(expiresAt).getTime();
  return !Number.isFinite(expiry) || expiry <= Date.now() + 120_000;
}

async function ensureValidAccessToken(repository, tenantId, connectionId, credentials) {
  if (!credentials) throw new Error("Google Ads connection credentials not found");
  if (!needsRefresh(credentials.access_token_expires_at) && credentials.accessToken) {
    return credentials.accessToken;
  }
  if (!credentials.refreshToken) {
    const error = new Error("Google Ads refresh token is unavailable");
    error.code = "GOOGLE_REFRESH_TOKEN_UNAVAILABLE";
    throw error;
  }

  const refreshed = await refreshAccessToken(credentials.refreshToken);
  const expiresAt = tokenExpiryDate(refreshed.expires_in);
  await repository.updateAccessToken(tenantId, connectionId, {
    accessToken: refreshed.access_token,
    expiresAt,
    tokenType: refreshed.token_type || "Bearer",
    scope: refreshed.scope || null,
  });
  return refreshed.access_token;
}

module.exports = { ensureValidAccessToken, needsRefresh };
