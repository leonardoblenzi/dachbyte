"use strict";

process.env.MAGALU_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString("base64");

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
const account = { id: 7, dach_tenant_id: "dach-7", magalu_tenant_id: "magalu-7", status: "active", scopes: ["scope"] };

test("catalog reads require allowed Hub READ access for the resolved account resource", async () => {
  let access = null;
  clearModule("../src/controllers/catalogController");
  await withLoadStubs({
    "../repositories/accountRepository": { findAccountByIdForTenant: async () => account },
    "../repositories/catalogRepository": { listCatalog: async () => ({ items: [] }) },
    "../repositories/syncRunRepository": {}, "../repositories/webhookRepository": {}, "../queues/magaluQueue": {},
    "../services/hubResourceAccessService": { checkAccountAccess: async (...args) => { access = args; return { allow: true }; } },
  }, () => require("../src/controllers/catalogController"), async (controller) => {
    const res = response();
    await controller.list({ query: { account_id: "7" }, body: {}, params: {}, magaluIdentity: identity }, res, (error) => { if (error) throw error; });
    assert.deepEqual(access, [identity, account, { action: "READ magalu" }]);
    assert.equal(res.result.body.ok, true);
  });
});

test("catalog reads deny through the controller error convention when Hub blocks the account resource", async () => {
  clearModule("../src/controllers/catalogController");
  await withLoadStubs({
    "../repositories/accountRepository": { findAccountByIdForTenant: async () => account },
    "../repositories/catalogRepository": { listCatalog: async () => { throw new Error("must not list"); } },
    "../repositories/syncRunRepository": {}, "../repositories/webhookRepository": {}, "../queues/magaluQueue": {},
    "../services/hubResourceAccessService": { checkAccountAccess: async () => ({ allow: false }) },
  }, () => require("../src/controllers/catalogController"), async (controller) => {
    let received = null;
    await controller.list({ query: { account_id: "7" }, body: {}, params: {}, magaluIdentity: identity }, response(), (error) => { received = error; });
    assert.equal(received.code, "MAGALU_ACCOUNT_NOT_FOUND");
    assert.equal(received.status, 404);
  });
});

test("foreign or missing catalog accounts fail before any Hub resource check", async () => {
  let checks = 0;
  clearModule("../src/controllers/catalogController");
  await withLoadStubs({
    "../repositories/accountRepository": { findAccountByIdForTenant: async () => null },
    "../repositories/catalogRepository": {}, "../repositories/syncRunRepository": {}, "../repositories/webhookRepository": {}, "../queues/magaluQueue": {},
    "../services/hubResourceAccessService": { checkAccountAccess: async () => { checks += 1; } },
  }, () => require("../src/controllers/catalogController"), async (controller) => {
    let received = null;
    await controller.list({ query: { account_id: "99" }, body: {}, params: {}, magaluIdentity: identity }, response(), (error) => { received = error; });
    assert.equal(received.code, "MAGALU_ACCOUNT_NOT_FOUND");
    assert.equal(checks, 0);
  });
});

test("write preview requires fresh allowed Hub WRITE access for the resolved account resource", async () => {
  let access = null;
  clearModule("../src/controllers/writeController");
  await withLoadStubs({
    "../config/env": { MAGALU_WRITE_ENABLED: true, MAGALU_WRITE_MAX_BATCH_SIZE: 50, MAGALU_WRITE_PREVIEW_TTL_SECONDS: 300 },
    "../repositories/accountRepository": { findAccountByIdForTenant: async () => account },
    "../repositories/writeRepository": {},
    "../services/writePreviewService": { buildPreview: async () => ({ preview_id: "pv" }), assertWriteReady: () => {} },
    "../services/hubResourceAccessService": { checkAccountAccess: async (...args) => { access = args; return { allow: true }; } },
    "../queues/magaluQueue": {}, "../services/writePayload": { PRICE_WRITE_SCOPE: "p", STOCK_WRITE_SCOPE: "s", hasScope: () => true },
  }, () => require("../src/controllers/writeController"), async (controller) => {
    const res = response();
    await controller.preview({ query: { account_id: "7" }, body: {}, params: {}, magaluIdentity: identity }, res, (error) => { if (error) throw error; });
    assert.deepEqual(access, [identity, account, { action: "WRITE magalu", force: true }]);
    assert.equal(res.result.body.ok, true);
  });
});

test("write preview denial stops before preview creation and missing accounts skip Hub", async () => {
  let previewCalls = 0;
  let checks = 0;
  clearModule("../src/controllers/writeController");
  await withLoadStubs({
    "../config/env": { MAGALU_WRITE_ENABLED: true, MAGALU_WRITE_MAX_BATCH_SIZE: 50, MAGALU_WRITE_PREVIEW_TTL_SECONDS: 300 },
    "../repositories/accountRepository": { findAccountByIdForTenant: async (id) => id === 7 ? account : null },
    "../repositories/writeRepository": {},
    "../services/writePreviewService": { buildPreview: async () => { previewCalls += 1; return {}; }, assertWriteReady: () => {} },
    "../services/hubResourceAccessService": { checkAccountAccess: async () => { checks += 1; return { allow: false }; } },
    "../queues/magaluQueue": {}, "../services/writePayload": { PRICE_WRITE_SCOPE: "p", STOCK_WRITE_SCOPE: "s", hasScope: () => true },
  }, () => require("../src/controllers/writeController"), async (controller) => {
    const denied = response();
    await controller.preview({ query: { account_id: "7" }, body: {}, params: {}, magaluIdentity: identity }, denied, (error) => { if (error) throw error; });
    assert.equal(denied.result.status, 403);
    assert.equal(denied.result.body.error, "MAGALU_WRITE_HUB_ACCESS_DENIED");
    assert.equal(previewCalls, 0);

    let received = null;
    await controller.preview({ query: { account_id: "99" }, body: {}, params: {}, magaluIdentity: identity }, response(), (error) => { received = error; });
    assert.equal(received.code, "MAGALU_ACCOUNT_NOT_FOUND");
    assert.equal(checks, 1);
  });
});

test("catalog sync and reconcile require allowed READ access to the tenant-owned account before enqueueing", async () => {
  const accesses = [];
  const queued = [];
  clearModule("../src/controllers/catalogController");
  await withLoadStubs({
    "../repositories/accountRepository": { findAccountByIdForTenant: async () => account, setCatalogSyncState: async () => {} },
    "../repositories/catalogRepository": {}, "../repositories/syncRunRepository": {}, "../repositories/webhookRepository": {},
    "../queues/magaluQueue": { enqueueCatalogSync: async (...args) => { queued.push(["sync", ...args]); return { id: "sync-job" }; }, enqueueCatalogReconcile: async (...args) => { queued.push(["reconcile", ...args]); return { id: "reconcile-job" }; } },
    "../services/hubResourceAccessService": { checkAccountAccess: async (...args) => { accesses.push(args); return { allow: true }; } },
  }, () => require("../src/controllers/catalogController"), async (controller) => {
    const sync = response();
    await controller.sync({ query: { account_id: "7" }, body: {}, params: {}, magaluIdentity: identity }, sync, (error) => { if (error) throw error; });
    const reconcile = response();
    await controller.reconcile({ query: { account_id: "7" }, body: {}, params: { sku: "SKU-7" }, magaluIdentity: identity }, reconcile, (error) => { if (error) throw error; });
    assert.deepEqual(accesses, [[identity, account, { action: "READ magalu" }], [identity, account, { action: "READ magalu" }]]);
    assert.equal(queued.length, 2);
  });
});

test("catalog enqueue denial is indistinguishable from a missing or foreign account and skips Hub when unresolved", async () => {
  let checks = 0;
  let enqueues = 0;
  clearModule("../src/controllers/catalogController");
  await withLoadStubs({
    "../repositories/accountRepository": { findAccountByIdForTenant: async (id) => id === 7 ? account : null, setCatalogSyncState: async () => {} },
    "../repositories/catalogRepository": {}, "../repositories/syncRunRepository": {}, "../repositories/webhookRepository": {},
    "../queues/magaluQueue": { enqueueCatalogSync: async () => { enqueues += 1; }, enqueueCatalogReconcile: async () => { enqueues += 1; } },
    "../services/hubResourceAccessService": { checkAccountAccess: async () => { checks += 1; return { allow: false }; } },
  }, () => require("../src/controllers/catalogController"), async (controller) => {
    for (const [method, request] of [["sync", { query: { account_id: "7" }, body: {}, params: {} }], ["reconcile", { query: { account_id: "7" }, body: {}, params: { sku: "SKU-7" } }]]) {
      let denied = null;
      await controller[method]({ ...request, magaluIdentity: identity }, response(), (error) => { denied = error; });
      assert.equal(denied.code, "MAGALU_ACCOUNT_NOT_FOUND");
      assert.equal(denied.status, 404);
    }
    for (const [method, request] of [["sync", { query: { account_id: "99" }, body: {}, params: {} }], ["reconcile", { query: { account_id: "99" }, body: {}, params: { sku: "SKU-7" } }]]) {
      let missing = null;
      await controller[method]({ ...request, magaluIdentity: identity }, response(), (error) => { missing = error; });
      assert.equal(missing.code, "MAGALU_ACCOUNT_NOT_FOUND");
      assert.equal(missing.status, 404);
    }
    assert.equal(checks, 2);
    assert.equal(enqueues, 0);
  });
});

test("write status, history, and single-operation reads require account-scoped READ access", async () => {
  const accesses = [];
  clearModule("../src/controllers/writeController");
  await withLoadStubs({
    "../config/env": { MAGALU_WRITE_ENABLED: true, MAGALU_WRITE_MAX_BATCH_SIZE: 50, MAGALU_WRITE_PREVIEW_TTL_SECONDS: 300 },
    "../repositories/accountRepository": { findAccountByIdForTenant: async () => account },
    "../repositories/writeRepository": { listOperations: async () => [], getOperationForTenant: async () => ({ id: 9, account_id: 7 }) },
    "../services/writePreviewService": { buildPreview: async () => ({}), assertWriteReady: () => {} },
    "../services/hubResourceAccessService": { checkAccountAccess: async (...args) => { accesses.push(args); return { allow: true }; } },
    "../queues/magaluQueue": {}, "../services/writePayload": { PRICE_WRITE_SCOPE: "p", STOCK_WRITE_SCOPE: "s", hasScope: () => true },
  }, () => require("../src/controllers/writeController"), async (controller) => {
    for (const [method, request] of [["status", { query: { account_id: "7" }, body: {}, params: {} }], ["operations", { query: { account_id: "7" }, body: {}, params: {} }], ["operation", { query: {}, body: {}, params: { operationId: "9" } }]]) {
      const res = response();
      await controller[method]({ ...request, magaluIdentity: identity }, res, (error) => { if (error) throw error; });
      assert.equal(res.result.body.ok, true);
    }
    assert.deepEqual(accesses, [[identity, account, { action: "READ magalu" }], [identity, account, { action: "READ magalu" }], [identity, account, { action: "READ magalu" }]]);
  });
});

test("write read denials are non-disclosing and missing or foreign records skip Hub", async () => {
  let checks = 0;
  clearModule("../src/controllers/writeController");
  await withLoadStubs({
    "../config/env": { MAGALU_WRITE_ENABLED: true, MAGALU_WRITE_MAX_BATCH_SIZE: 50, MAGALU_WRITE_PREVIEW_TTL_SECONDS: 300 },
    "../repositories/accountRepository": { findAccountByIdForTenant: async (id) => id === 7 ? account : null },
    "../repositories/writeRepository": { listOperations: async () => { throw new Error("must not list"); }, getOperationForTenant: async (id) => id === 9 ? { id: 9, account_id: 7 } : null },
    "../services/writePreviewService": { buildPreview: async () => ({}), assertWriteReady: () => {} },
    "../services/hubResourceAccessService": { checkAccountAccess: async () => { checks += 1; return { allow: false }; } },
    "../queues/magaluQueue": {}, "../services/writePayload": { PRICE_WRITE_SCOPE: "p", STOCK_WRITE_SCOPE: "s", hasScope: () => true },
  }, () => require("../src/controllers/writeController"), async (controller) => {
    for (const method of ["status", "operations"]) {
      let denied = null;
      await controller[method]({ query: { account_id: "7" }, body: {}, params: {}, magaluIdentity: identity }, response(), (error) => { denied = error; });
      assert.equal(denied.code, "MAGALU_ACCOUNT_NOT_FOUND");
      assert.equal(denied.status, 404);
      let missing = null;
      await controller[method]({ query: { account_id: "99" }, body: {}, params: {}, magaluIdentity: identity }, response(), (error) => { missing = error; });
      assert.equal(missing.code, "MAGALU_ACCOUNT_NOT_FOUND");
    }
    const deniedOperation = response();
    await controller.operation({ query: {}, body: {}, params: { operationId: "9" }, magaluIdentity: identity }, deniedOperation, (error) => { if (error) throw error; });
    assert.deepEqual(deniedOperation.result, { status: 404, body: { ok: false, error: "MAGALU_WRITE_OPERATION_NOT_FOUND" } });
    const missingOperation = response();
    await controller.operation({ query: {}, body: {}, params: { operationId: "99" }, magaluIdentity: identity }, missingOperation, (error) => { if (error) throw error; });
    assert.deepEqual(missingOperation.result, { status: 404, body: { ok: false, error: "MAGALU_WRITE_OPERATION_NOT_FOUND" } });
    assert.equal(checks, 3);
  });
});
