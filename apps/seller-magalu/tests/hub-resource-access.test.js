"use strict";

process.env.MAGALU_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");

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

test("Hub resource access constructs the exact Magalu account resource without OAuth data", async () => {
  let captured = null;
  clearModule("../src/services/hubResourceAccessService");
  await withLoadStubs({
    "./hubAccessService": { checkHubAccess: async (identity, options) => { captured = { identity, options }; return { allow: true }; } },
  }, () => require("../src/services/hubResourceAccessService"), async (service) => {
    const identity = { dachTenantId: "dach-7", dachUserId: "user-7", accessToken: "must-not-pass" };
    const account = { id: 7, magalu_tenant_id: "tenant-abc", access_token: "secret" };
    const result = await service.checkAccountAccess(identity, account, { action: "READ magalu" });

    assert.equal(result.allow, true);
    assert.deepEqual(captured, {
      identity: { dachTenantId: "dach-7", dachUserId: "user-7" },
      options: { action: "READ magalu", resourceKey: "magalu:tenant-abc" },
    });
  });
});

test("Hub access cache keys distinguish Magalu account resources", () => {
  clearModule("../src/services/hubAccessService");
  const { _test } = require("../src/services/hubAccessService");
  const identity = { dachTenantId: "dach-7", dachUserId: "user-7" };

  assert.notEqual(
    _test.cacheKey(identity, "READ magalu", "magalu:tenant-a"),
    _test.cacheKey(identity, "READ magalu", "magalu:tenant-b"),
  );
});

test("Hub access sends resource_key only for resource-scoped checks", async () => {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ allow: true }) };
  };
  clearModule("../src/services/hubAccessService");
  try {
    await withLoadStubs({
      "../config/env": { HUB_BASE_URL: "https://hub.example", HUB_INTERNAL_TOKEN: "internal", HUB_REQUEST_TIMEOUT_MS: 1000, MAGALU_HUB_GATE_MODE: "strict" },
    }, () => require("../src/services/hubAccessService"), async (hub) => {
      const identity = { dachTenantId: "dach-7", dachUserId: "user-7" };
      await hub.checkHubAccess(identity, { action: "READ magalu", resourceKey: "magalu:tenant-7", force: true });
      await hub.checkHubAccess(identity, { action: "READ magalu", force: true });
    });
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(requests[0].resource_key, "magalu:tenant-7");
  assert.equal(Object.hasOwn(requests[1], "resource_key"), false);
});
