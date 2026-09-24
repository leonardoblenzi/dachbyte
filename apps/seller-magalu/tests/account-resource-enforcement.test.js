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
    assert.equal(received.code, "MAGALU_HUB_ACCESS_DENIED");
    assert.equal(received.status, 403);
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
