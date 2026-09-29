// services/ml-auth.js
// Adaptador legado/per-account para obter access_token usando TokenService.
"use strict";

const TokenService = require("./tokenService");
const { isProductionEnvironment } = require("../../../lib/runtimeEnv");

function normKey(accountId) {
  return String(accountId || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_");
}

function pickEnv(name) {
  return process.env[name];
}

function resolveCredsForAccount(accountId) {
  const K = normKey(accountId);

  const perAccount = {
    app_id: pickEnv(`ML_${K}_APP_ID`),
    client_secret: pickEnv(`ML_${K}_CLIENT_SECRET`),
    refresh_token: pickEnv(`ML_${K}_REFRESH_TOKEN`),
    access_token: pickEnv(`ML_${K}_ACCESS_TOKEN`),
    access_expires_at: pickEnv(`ML_${K}_ACCESS_EXPIRES_AT`),
    redirect_uri: pickEnv(`ML_${K}_REDIRECT_URI`),
  };

  const globalCreds = {
    app_id:
      pickEnv("APP_ID") ||
      pickEnv("ML_APP_ID") ||
      pickEnv("MERCADOLIBRE_APP_ID"),
    client_secret:
      pickEnv("CLIENT_SECRET") ||
      pickEnv("ML_CLIENT_SECRET") ||
      pickEnv("MERCADOLIBRE_CLIENT_SECRET"),
    refresh_token:
      pickEnv("REFRESH_TOKEN") ||
      pickEnv("ML_REFRESH_TOKEN") ||
      pickEnv("MERCADOLIBRE_REFRESH_TOKEN"),
    access_token:
      pickEnv("ACCESS_TOKEN") || pickEnv("MERCADOLIBRE_ACCESS_TOKEN"),
    access_expires_at:
      pickEnv("ACCESS_EXPIRES_AT") || pickEnv("ML_ACCESS_EXPIRES_AT"),
    redirect_uri: pickEnv("REDIRECT_URI") || pickEnv("ML_REDIRECT_URI"),
  };

  return {
    app_id: perAccount.app_id || globalCreds.app_id,
    client_secret: perAccount.client_secret || globalCreds.client_secret,
    refresh_token: perAccount.refresh_token || globalCreds.refresh_token,
    access_token: perAccount.access_token || globalCreds.access_token,
    access_expires_at:
      perAccount.access_expires_at || globalCreds.access_expires_at || null,
    redirect_uri: perAccount.redirect_uri || globalCreds.redirect_uri,
    account_key: accountId,
  };
}

async function getAccessTokenForAccount(accountId) {
  if (!accountId) {
    throw new Error("getAccessTokenForAccount: accountId e obrigatorio");
  }

  const creds = resolveCredsForAccount(accountId);
  const token = await TokenService.renovarTokenSeNecessario(creds);

  const K = normKey(accountId);
  if (!isProductionEnvironment()) {
    process.env[`ML_${K}_ACCESS_TOKEN`] = token;
    if (creds.access_expires_at) {
      process.env[`ML_${K}_ACCESS_EXPIRES_AT`] = String(creds.access_expires_at);
    }
    process.env.ACCESS_TOKEN = token;
    if (creds.access_expires_at) {
      process.env.ACCESS_EXPIRES_AT = String(creds.access_expires_at);
    }
  }

  return token;
}

module.exports = { getAccessTokenForAccount, resolveCredsForAccount };
