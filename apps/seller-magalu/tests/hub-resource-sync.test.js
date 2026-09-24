"use strict";

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

test("Hub resource sync sends only the allowed connected-account payload", async () => {
  let request = null;
  clearModule("../src/services/hubResourceSyncService");
  await withLoadStubs({
    "../config/env": { HUB_BASE_URL: "https://hub.example", HUB_INTERNAL_TOKEN: "internal-token", HUB_REQUEST_TIMEOUT_MS: 1000 },
  }, () => require("../src/services/hubResourceSyncService"), async (service) => {
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ resource_key: "hub-resource-7" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const result = await service.syncHubResource({
        id: 7,
        dach_tenant_id: "dach-tenant",
        magalu_tenant_id: "magalu-tenant",
        magalu_tenant_name: "Loja Magalu",
        scopes: ["catalog:read"],
        metadata: { access_token: "must-not-leak", refresh_expires_at: "must-not-leak" },
      });
      assert.equal(result.resourceKey, "hub-resource-7");
      assert.equal(request.url, "https://hub.example/v1/internal/resources/sync");
      assert.equal(request.options.headers.authorization, "Bearer internal-token");
      assert.deepEqual(JSON.parse(request.options.body), {
        tenant_id: "dach-tenant",
        module_slug: "magalu",
        account_id: "magalu-tenant",
        label: "Loja Magalu",
        metadata: { provider: "magalu", local_account_id: 7, scopes: ["catalog:read"] },
      });
    } finally { global.fetch = originalFetch; }
  });
});

test("Hub resource queue uses a stable account job with exponential retries", async () => {
  const added = [];
  clearModule("../src/queues/magaluQueue");
  class FakeQueue {
    constructor(name) { this.name = name; }
    async add(name, data, options) { added.push({ queue: this.name, name, data, options }); return { id: "job-7" }; }
    async close() {}
  }
  await withLoadStubs({
    bullmq: { Queue: FakeQueue },
    "../config/redis": { ensureRedisConnected: async () => ({}) },
    "../config/queueNames": { webhookProcess: "magalu:webhook:process", tokenRefresh: "magalu:token:refresh", catalogSync: "magalu:catalog:sync", priceUpdate: "magalu:price:update", stockUpdate: "magalu:stock:update", hubResourceSync: "magalu:hub-resource:sync" },
  }, () => require("../src/queues/magaluQueue"), async (queue) => {
    await queue.enqueueHubResourceSync(7);
  });
  assert.deepEqual(added[0], {
    queue: "magalu:hub-resource:sync",
    name: "sync-resource",
    data: { accountId: 7 },
    options: { jobId: "magalu-hub-resource-7", attempts: 5, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: true, removeOnFail: true },
  });
});

test("Hub resource worker persists synced state and truncates sync errors", async () => {
  const states = [];
  clearModule("../src/jobs/hubResourceSync.worker");
  await withLoadStubs({
    bullmq: { Worker: class Worker {} },
    "../config/redis": { ensureRedisConnected: async () => ({}) },
    "../config/queueNames": { hubResourceSync: "magalu:hub-resource:sync" },
    "../repositories/accountRepository": {
      findAccountById: async () => ({ id: 7, dach_tenant_id: "dach-tenant", magalu_tenant_id: "magalu-tenant", magalu_tenant_name: "Loja", scopes: [] }),
      setHubResourceSyncState: async (_id, state) => states.push(state),
    },
    "../services/hubResourceSyncService": { syncHubResource: async () => ({ resourceKey: "hub-resource-7" }) },
  }, () => require("../src/jobs/hubResourceSync.worker"), async (worker) => {
    const result = await worker._test.processHubResourceSyncJob({ data: { accountId: 7 } });
    assert.equal(result.resourceKey, "hub-resource-7");
  });
  assert.equal(states[0].status, "syncing");
  assert.deepEqual(states[1], { status: "synced", hubResourceKey: "hub-resource-7", syncedAt: states[1].syncedAt, error: null });

  const failures = [];
  clearModule("../src/jobs/hubResourceSync.worker");
  await withLoadStubs({
    bullmq: { Worker: class Worker {} },
    "../config/redis": { ensureRedisConnected: async () => ({}) },
    "../config/queueNames": { hubResourceSync: "magalu:hub-resource:sync" },
    "../repositories/accountRepository": { findAccountById: async () => ({ id: 7 }), setHubResourceSyncState: async (_id, state) => failures.push(state) },
    "../services/hubResourceSyncService": { syncHubResource: async () => { throw new Error("x".repeat(2500)); } },
  }, () => require("../src/jobs/hubResourceSync.worker"), async (worker) => {
    await assert.rejects(worker._test.processHubResourceSyncJob({ data: { accountId: 7 } }));
  });
  assert.equal(failures[1].status, "failed");
  assert.equal(failures[1].error.length, 2000);
});

test("OAuth remains connected when Hub resource enqueue fails", async () => {
  const hubStates = [];
  clearModule("../src/controllers/oauthController");
  const originalWarn = console.warn;
  console.warn = () => {};
  await withLoadStubs({
    "../config/env": { NODE_ENV: "test", MAGALU_TOKEN_REFRESH_SKEW_SECONDS: 900 },
    "../repositories/oauthStateRepository": { consumeState: async () => ({ dach_tenant_id: "dach", dach_user_id: "user", redirect_after: "/magalu/contas" }) },
    "../repositories/accountRepository": { setCatalogSyncState: async () => {}, setHubResourceSyncState: async (_id, state) => hubStates.push(state) },
    "../queues/magaluQueue": { enqueueTokenRefresh: async () => null, enqueueCatalogSync: async () => ({ id: "catalog" }), enqueueHubResourceSync: async () => { throw new Error("redis unavailable"); } },
    "../services/magaluTokenService": { refreshAccount: async () => ({}) },
    "../services/hubAccessService": { checkHubAccess: async () => ({ allow: true }) },
    "../middlewares/suiteAuth": { readSuiteIdentity: () => ({ ok: true, identity: { dachTenantId: "dach", dachUserId: "user" } }) },
    "../services/magaluOAuthService": { beginAuthorization: async () => ({}), finishAuthorization: async () => ({ account: { id: 7 }, accessExpiresAt: null }), publicOAuthConfig: () => ({}) },
    "../services/oauthSecurity": { hashOAuthState: (value) => value, safeRedirectAfter: (value) => value, secureEqual: () => true },
  }, () => require("../src/controllers/oauthController"), async (controller) => {
    try {
      let location = null;
      await controller.callback({ query: { state: "state", code: "code" }, headers: { cookie: "magalu_oauth_state=state" } }, {
        clearCookie() {},
        redirect(_status, target) { location = target; },
      });
      assert.match(location, /oauth=connected/);
    } finally { console.warn = originalWarn; }
  });
  assert.equal(hubStates.length, 1);
  assert.equal(hubStates[0].status, "pending");
});
