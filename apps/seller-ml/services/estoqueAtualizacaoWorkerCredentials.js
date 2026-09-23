"use strict";

let dependencies = null;

function getDependencies() {
  if (!dependencies) {
    dependencies = {
      db: require("../db/db"),
      decryptToken: require("./tokenCrypto").decryptToken,
      refreshToken: require("./tokenService").renovarTokenSeNecessario,
      fetch: typeof fetch !== "undefined" ? fetch : require("node-fetch"),
    };
  }
  return dependencies;
}

function fail(message, statusCode = 409) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function accountId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isActive(status) {
  return ["ativa", "active"].includes(String(status || "").trim().toLowerCase());
}

async function loadWorkerCredentials(accountKey) {
  const deps = getDependencies();
  const id = accountId(accountKey);
  if (!id) throw fail("Conta Mercado Livre invalida para o job de estoque.");
  const result = await deps.db.query(
    `select mc.id, mc.meli_user_id, mc.status,
            mt.access_token, mt.access_expires_at, mt.refresh_token, mt.scope
       from meli_contas mc
       join meli_tokens mt on mt.meli_conta_id = mc.id
      where mc.id = $1
      limit 1`,
    [id],
  );
  const row = result?.rows?.[0];
  if (!row) throw fail("Conta Mercado Livre nao encontrada ou sem tokens para o job de estoque.");
  if (!isActive(row.status)) throw fail("Conta Mercado Livre nao esta ativa para o job de estoque.");

  const accessToken = deps.decryptToken(row.access_token);
  const refreshToken = deps.decryptToken(row.refresh_token);
  if (!accessToken || !refreshToken) {
    throw fail("Credenciais OAuth da conta Mercado Livre estao incompletas para o job de estoque.", 503);
  }
  const mlCreds = {
    app_id: process.env.ML_APP_ID || process.env.APP_ID || process.env.CLIENT_ID || null,
    client_secret: process.env.ML_CLIENT_SECRET || process.env.CLIENT_SECRET || null,
    redirect_uri: process.env.ML_REDIRECT_URI || process.env.REDIRECT_URI || null,
    access_token: accessToken,
    refresh_token: refreshToken,
    access_expires_at: row.access_expires_at || null,
    scope: row.scope || null,
    meli_conta_id: id,
    meli_user_id: String(row.meli_user_id || ""),
    account_key: String(id),
  };
  if (!mlCreds.meli_user_id) throw fail("Conta Mercado Livre sem seller identificado.");

  const freshAccessToken = await deps.refreshToken(mlCreds);
  if (!freshAccessToken) throw fail("Nao foi possivel renovar o token da conta Mercado Livre.", 503);
  const me = await deps.fetch("https://api.mercadolibre.com/users/me", {
    headers: { Authorization: `Bearer ${freshAccessToken}`, Accept: "application/json" },
  });
  const seller = await me.json().catch(() => null);
  if (!me.ok || !seller?.id || String(seller.id) !== mlCreds.meli_user_id) {
    throw fail("A identidade do seller nao corresponde a conta selecionada para o job de estoque.");
  }
  mlCreds.access_token = freshAccessToken;
  return { accessToken: freshAccessToken, mlCreds };
}

module.exports = {
  loadWorkerCredentials,
  _test: {
    setDependencies(next) { dependencies = { ...(next || {}) }; },
    resetDependencies() { dependencies = null; },
  },
};
