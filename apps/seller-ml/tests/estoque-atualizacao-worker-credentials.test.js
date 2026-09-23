"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const loader = require("../services/estoqueAtualizacaoWorkerCredentials");

function configure({ accounts, tokenByAccount, sellerByToken }) {
  loader._test.setDependencies({
    db: {
      query: async (_sql, [accountId]) => ({
        rows: accounts[String(accountId)] ? [{
          ...accounts[String(accountId)],
          access_token: tokenByAccount[String(accountId)]?.access_token,
          refresh_token: tokenByAccount[String(accountId)]?.refresh_token,
          access_expires_at: "2099-01-01T00:00:00.000Z",
        }] : [],
      }),
    },
    decryptToken: (value) => String(value || "").replace(/^enc:/, ""),
    refreshToken: async (creds) => creds.access_token,
    fetch: async (_url, init) => ({
      ok: true,
      status: 200,
      json: async () => ({ id: sellerByToken[init.headers.Authorization] }),
    }),
  });
}

test("worker credentials are loaded only from the selected DB account", async () => {
  configure({
    accounts: {
      1: { id: 1, meli_user_id: "101", status: "ativa" },
      2: { id: 2, meli_user_id: "202", status: "ativa" },
    },
    tokenByAccount: {
      1: { access_token: "enc:token-A", refresh_token: "enc:refresh-A" },
      2: { access_token: "enc:token-B", refresh_token: "enc:refresh-B" },
    },
    sellerByToken: { "Bearer token-A": "101", "Bearer token-B": "202" },
  });

  const credentials = await loader.loadWorkerCredentials("1");

  assert.equal(credentials.accessToken, "token-A");
  assert.equal(credentials.mlCreds.refresh_token, "refresh-A");
  assert.equal(credentials.mlCreds.meli_conta_id, 1);
  assert.equal(credentials.mlCreds.meli_user_id, "101");
});

test("worker credentials fail closed for missing, inactive, and seller-mismatched accounts", async () => {
  configure({
    accounts: {
      2: { id: 2, meli_user_id: "202", status: "revogada" },
      3: { id: 3, meli_user_id: "303", status: "ativa" },
    },
    tokenByAccount: {
      2: { access_token: "enc:token-B", refresh_token: "enc:refresh-B" },
      3: { access_token: "enc:token-C", refresh_token: "enc:refresh-C" },
    },
    sellerByToken: { "Bearer token-B": "202", "Bearer token-C": "999" },
  });

  await assert.rejects(loader.loadWorkerCredentials("404"), /nao encontrada/i);
  await assert.rejects(loader.loadWorkerCredentials("2"), /ativa/i);
  await assert.rejects(loader.loadWorkerCredentials("3"), /seller/i);
});

test("worker refresh receives OAuth app configuration and verifies the refreshed account token", async () => {
  const previous = {
    appId: process.env.ML_APP_ID,
    secret: process.env.ML_CLIENT_SECRET,
    redirect: process.env.ML_REDIRECT_URI,
  };
  process.env.ML_APP_ID = "configured-app";
  process.env.ML_CLIENT_SECRET = "configured-secret";
  process.env.ML_REDIRECT_URI = "https://example.test/oauth";
  let refreshed;
  loader._test.setDependencies({
    db: { query: async () => ({ rows: [{
      id: 9, meli_user_id: "909", status: "ativa", access_token: "enc:expired-token",
      refresh_token: "enc:refresh-9", access_expires_at: "2000-01-01T00:00:00.000Z",
    }] }) },
    decryptToken: (value) => String(value).replace(/^enc:/, ""),
    refreshToken: async (creds) => { refreshed = creds; return "refreshed-token"; },
    fetch: async (_url, init) => ({ ok: true, json: async () => ({ id: init.headers.Authorization === "Bearer refreshed-token" ? "909" : null }) }),
  });

  const result = await loader.loadWorkerCredentials("9");

  assert.equal(refreshed.app_id, "configured-app");
  assert.equal(refreshed.client_secret, "configured-secret");
  assert.equal(refreshed.redirect_uri, "https://example.test/oauth");
  assert.equal(result.accessToken, "refreshed-token");
  process.env.ML_APP_ID = previous.appId;
  process.env.ML_CLIENT_SECRET = previous.secret;
  process.env.ML_REDIRECT_URI = previous.redirect;
  loader._test.resetDependencies();
});
