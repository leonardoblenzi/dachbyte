"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

async function withStubs(stubs, modulePath, run) {
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return original.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve(modulePath)];
  try { return await run(require(modulePath)); }
  finally { Module._load = original; delete require.cache[require.resolve(modulePath)]; }
}

test("OAuth de conta já existente agenda nova sincronização do recurso Hub", async () => {
  const queries = [];
  const client = { query: async (sql, params = []) => {
    queries.push({ sql, params });
    if (/select id, dach_tenant_id, magalu_tenant_id from magalu\.accounts/i.test(sql)) {
      return { rows: [{ id: 42, dach_tenant_id: "dach-a", magalu_tenant_id: "magalu-a" }] };
    }
    if (/update magalu\.accounts/i.test(sql)) return { rows: [{ id: 42, status: "active" }] };
    throw new Error(`SQL inesperado: ${sql}`);
  } };
  await withStubs({ "../config/postgres": {} }, "../src/repositories/accountRepository", async (repo) => {
    await repo.upsertConnectedAccount(client, { dachTenantId: "dach-a", dachUserId: "user-a", magaluTenantId: "magalu-a", scopes: ["scope:new"] });
  });
  const update = queries.find(({ sql }) => /update magalu\.accounts/i.test(sql));
  assert.match(update.sql, /hub_sync_status\s*=\s*'pending'/i);
  assert.match(update.sql, /hub_sync_error\s*=\s*null/i);
});

test("Reconectar conta ativa inicia OAuth limitado à mesma organização e ao tenant DACH", async () => {
  const calls = [];
  const identity = { dachTenantId: "dach-a", dachUserId: "user-a" };
  await withStubs({
    "../config/env": { MAGALU_OAUTH_STATE_TTL_SECONDS: 600, MAGALU_OAUTH_SCOPES: ["scope:new"] },
    "../repositories/accountRepository": { findAccountByIdForTenant: async (id, tenant) => tenant === "dach-a" && id === 42 ? { id: 42, status: "active", magalu_tenant_id: "magalu-a" } : null },
    "../services/hubAccessService": { checkHubAccess: async (_identity, options) => { calls.push(options); return { allow: true }; } },
    "../services/magaluOAuthService": { beginAuthorization: async (options) => { calls.push(options); return { stateHash: "hash", authorizationUrl: "https://id.magalu.test/authorize" }; } },
    "../services/auditService": { recordBestEffort: async () => {} },
    "../services/oauthSecurity": { safeRedirectAfter: (value) => value },
    "../queues/magaluQueue": {}, "../services/magaluTokenService": {}, "../middlewares/suiteAuth": {},
    "../repositories/oauthStateRepository": {}, "../services/hubResourceAccessService": {},
  }, "../src/controllers/oauthController", async (controller) => {
    const response = { status: null, url: null, cookie() {}, redirect(status, url) { this.status = status; this.url = url; } };
    await controller.reconnectStart({ params: { accountId: "42" }, magaluIdentity: identity }, response, (error) => { throw error; });
    assert.equal(response.status, 302);
    assert.equal(response.url, "https://id.magalu.test/authorize");
    assert.deepEqual(calls[0], { force: true, action: "ACCESS magalu" });
    assert.deepEqual(calls[1], { identity, redirectAfter: "/magalu/contas", targetAccountId: 42, expectedMagaluTenantId: "magalu-a" });
  });
});

test("Callback de reconexão recusa conta desvinculada durante o consentimento", async () => {
  const identity = { dachTenantId: "dach-a", dachUserId: "user-a" };
  await withStubs({
    "../config/env": {},
    "../repositories/accountRepository": { findAccountByIdForTenant: async () => ({ id: 42, status: "revoked", magalu_tenant_id: "magalu-a" }) },
    "../services/hubAccessService": { checkHubAccess: async () => ({ allow: true }) },
    "../middlewares/suiteAuth": { readSuiteIdentity: () => ({ ok: true, identity }) },
    "../queues/magaluQueue": {}, "../services/magaluTokenService": {},
    "../repositories/oauthStateRepository": {}, "../services/hubResourceAccessService": {},
    "../services/magaluOAuthService": {}, "../services/auditService": {}, "../services/oauthSecurity": {},
  }, "../src/controllers/oauthController", async (controller) => {
    await assert.rejects(controller._test.revalidateCallbackAccess({}, {
      dach_tenant_id: "dach-a", dach_user_id: "user-a", target_account_id: 42,
      expected_magalu_tenant_id: "magalu-a", flow_mode: "tenant",
    }), (error) => error?.code === "MAGALU_RECONNECT_ACCOUNT_INACTIVE");
  });
});

test("Organização diferente no retorno OAuth não grava tokens no vínculo escolhido", async () => {
  let writes = 0;
  await withStubs({
    "../config/env": {},
    "../config/postgres": { withClient: async () => { writes += 1; } },
    "../repositories/oauthStateRepository": {}, "../repositories/accountRepository": {}, "../repositories/tokenRepository": {},
    "./magaluOAuthProtocol": {
      exchangeAuthorizationCode: async () => ({ token: "opaque" }),
      normalizeTokenSet: () => ({ subject: "wrong-org", scopes: ["scope:new"] }),
    },
  }, "../src/services/magaluOAuthService", async (service) => {
    await assert.rejects(service.finishAuthorization({
      stateRecord: { dach_tenant_id: "dach-a", dach_user_id: "user-a", expected_magalu_tenant_id: "magalu-a", target_account_id: 42 },
      code: "opaque-code",
    }), (error) => error?.code === "MAGALU_RECONNECT_ACCOUNT_MISMATCH");
    assert.equal(writes, 0);
  });
});

test("Botões de reconexão usam a conta selecionada e não o OAuth genérico", () => {
  const base = path.resolve(__dirname, "..");
  const accountJs = fs.readFileSync(path.join(base, "public/js/magalu-account.js"), "utf8");
  const appJs = fs.readFileSync(path.join(base, "public/js/magalu-app.js"), "utf8");
  const ordersJs = fs.readFileSync(path.join(base, "public/js/magalu-orders.js"), "utf8");
  assert.match(accountJs, /reconnect\.href\s*=\s*`\/magalu\/auth\/accounts\/\$\{id\}\/reconnect`/);
  assert.match(appJs, /mg-reconnect-account[\s\S]*auth\/accounts/);
  assert.match(appJs, /A conta aparecerá após o Hub confirmar o acesso comercial/);
  assert.match(appJs, /magalu_reconnect_account_mismatch:/);
  assert.match(ordersJs, /reconnect\.href\s*=\s*`\/magalu\/auth\/accounts\/\$\{state\.accountId\}\/reconnect`/);
});
