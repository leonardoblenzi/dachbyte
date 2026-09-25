"use strict";

process.env.MAGALU_ENCRYPTION_KEY = Buffer.alloc(32, 29).toString("base64");

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function clearModule(relative) { try { delete require.cache[require.resolve(relative)]; } catch (_error) {} }
async function withLoadStubs(stubs, load, run) {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return original.call(this, request, parent, isMain);
  };
  try { return await run(load()); } finally { Module._load = original; }
}
function response() { const result = {}; return { result, status(code) { result.status = code; return this; }, json(body) { result.body = body; return body; } }; }
const identity = { dachTenantId: "dach-7", dachUserId: "user-7" };
const allowed = { id: 7, dach_tenant_id: "dach-7", magalu_tenant_id: "magalu-7", status: "active" };
const denied = { id: 8, dach_tenant_id: "dach-7", magalu_tenant_id: "magalu-8", status: "active" };

function stubs(overrides = {}) {
  return {
    "../config/env": { NODE_ENV: "test", MAGALU_OAUTH_STATE_TTL_SECONDS: 600, MAGALU_TOKEN_REFRESH_SKEW_SECONDS: 900 },
    "../repositories/oauthStateRepository": {},
    "../repositories/accountRepository": {},
    "../queues/magaluQueue": {},
    "../services/magaluTokenService": {},
    "../services/hubAccessService": {},
    "../services/hubResourceAccessService": {},
    "../middlewares/suiteAuth": {},
    "../services/magaluOAuthService": { publicOAuthConfig: () => ({ configured: true }) },
    "../services/oauthSecurity": { hashOAuthState: () => "", safeRedirectAfter: (value) => value, secureEqual: () => true },
    ...overrides,
  };
}

test("refresh requires fresh WRITE access for the exact tenant-owned account before credentials refresh", async () => {
  let access = null;
  let refreshes = 0;
  clearModule("../src/controllers/oauthController");
  await withLoadStubs(stubs({
    "../repositories/accountRepository": { findAccountByIdForTenant: async () => allowed },
    "../services/magaluTokenService": { refreshAccount: async () => { refreshes += 1; return { accessExpiresAt: "future", scopes: ["scope"] }; } },
    "../services/hubResourceAccessService": { checkAccountAccess: async (...args) => { access = args; return { allow: true }; } },
  }), () => require("../src/controllers/oauthController"), async (controller) => {
    const res = response();
    await controller.refresh({ params: { accountId: "7" }, magaluIdentity: identity }, res, (error) => { if (error) throw error; });
    assert.deepEqual(access, [identity, allowed, { action: "WRITE magalu", force: true }]);
    assert.equal(refreshes, 1);
    assert.equal(res.result.body.account_id, 7);
  });
});

test("denied, missing, or foreign refreshes are non-disclosing and never refresh credentials", async () => {
  let checks = 0;
  let refreshes = 0;
  clearModule("../src/controllers/oauthController");
  await withLoadStubs(stubs({
    "../repositories/accountRepository": { findAccountByIdForTenant: async (id) => id === 7 ? denied : null },
    "../services/magaluTokenService": { refreshAccount: async () => { refreshes += 1; } },
    "../services/hubResourceAccessService": { checkAccountAccess: async () => { checks += 1; return { allow: false }; } },
  }), () => require("../src/controllers/oauthController"), async (controller) => {
    for (const accountId of ["7", "99"]) {
      const res = response();
      await controller.refresh({ params: { accountId }, magaluIdentity: identity }, res, (error) => { if (error) throw error; });
      assert.deepEqual(res.result, { status: 404, body: { ok: false, error: "account_not_found" } });
    }
    assert.equal(checks, 1);
    assert.equal(refreshes, 0);
  });
});

test("accounts and OAuth status omit denied account resources", async () => {
  const accesses = [];
  clearModule("../src/controllers/oauthController");
  await withLoadStubs(stubs({
    "../repositories/accountRepository": { listAccountsForTenant: async () => [allowed, denied] },
    "../services/hubResourceAccessService": { checkAccountAccess: async (...args) => { accesses.push(args); return { allow: args[1].id === 7 }; } },
  }), () => require("../src/controllers/oauthController"), async (controller) => {
    const accounts = response();
    await controller.accounts({ magaluIdentity: identity }, accounts, (error) => { if (error) throw error; });
    const status = response();
    await controller.status({ magaluIdentity: identity }, status);
    assert.deepEqual(accounts.result.body.accounts, [allowed]);
    assert.deepEqual(status.result.body.accounts, [allowed]);
    assert.deepEqual(accesses.map((args) => args[2]), [{ action: "READ magalu" }, { action: "READ magalu" }, { action: "READ magalu" }, { action: "READ magalu" }]);
  });
});

test("OAuth status omits revoked accounts before checking Hub resources", async () => {
  const revoked = { id: 9, dach_tenant_id: "dach-7", magalu_tenant_id: "magalu-9", status: "revoked" };
  const checked = [];
  clearModule("../src/controllers/oauthController");
  await withLoadStubs(stubs({
    "../repositories/accountRepository": { listAccountsForTenant: async () => [allowed, revoked] },
    "../services/hubResourceAccessService": { checkAccountAccess: async (...args) => { checked.push(args[1].id); return { allow: true }; } },
  }), () => require("../src/controllers/oauthController"), async (controller) => {
    const status = response();
    await controller.status({ magaluIdentity: identity }, status);
    assert.deepEqual(status.result.body.accounts, [allowed]);
    assert.deepEqual(checked, [7]);
  });
});
