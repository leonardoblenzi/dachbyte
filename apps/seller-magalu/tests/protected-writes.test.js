"use strict";
process.env.MAGALU_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
process.env.MAGALU_WRITE_ENABLED = "true";
process.env.MAGALU_RATE_LIMIT_PRICE_WRITE_PER_MINUTE = "800";
process.env.MAGALU_RATE_LIMIT_STOCK_WRITE_PER_MINUTE = "600";
process.env.MAGALU_WRITE_VERIFY_ATTEMPTS = "2";
process.env.MAGALU_WRITE_VERIFY_DELAY_MS = "1";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const payload = require("../src/services/writePayload");

function clearModule(relative) { try { delete require.cache[require.resolve(relative)]; } catch (_error) {} }
async function withLoadStubs(stubs, load, run) {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return original.call(this, request, parent, isMain);
  };
  try { return await run(load()); } finally { Module._load = original; }
}

test("price payload enforces list_price and stock is absolute non-negative integer", () => {
  assert.deepEqual(payload.buildPricePayload({ price: "89.90", list_price: "109.90" }), { price: 89.9, list_price: 109.9 });
  assert.throws(() => payload.buildPricePayload({ price: 120, list_price: 100 }), (error) => error.code === "MAGALU_PRICE_ABOVE_LIST_PRICE");
  assert.deepEqual(payload.buildStockPayload({ quantity: "0" }), { quantity: 0 });
  assert.throws(() => payload.buildStockPayload({ quantity: 2.5 }), (error) => error.code === "MAGALU_STOCK_INVALID");
});

test("write request hash is deterministic and resource scopes are isolated", () => {
  const a = payload.requestHash("price", "SKU1", { price: 10, list_price: 12 }, { price: 11, list_price: 12 });
  const b = payload.requestHash("price", "SKU1", { list_price: 12, price: 10 }, { list_price: 12, price: 11 });
  assert.equal(a, b);
  assert.equal(payload.scopeFor("price"), "open:portfolio-prices-seller:write");
  assert.equal(payload.scopeFor("stock"), "open:portfolio-stocks-seller:write");
});

test("portfolio write service uses POST for missing resource, PATCH for existing and never retries writes", async () => {
  const calls = [];
  clearModule("../src/services/portfolioWriteService");
  await withLoadStubs({
    "./magaluApiClient": { request: async (path, options) => { calls.push({ path, options }); return { status: 202, data: {} }; } },
    "./magaluRateLimiter": { waitFor: async (...args) => calls.push({ rate: args }) },
  }, () => require("../src/services/portfolioWriteService"), async (service) => {
    await service.writeResource(1, "dach", "price", "SKU/1", { price: 10, list_price: 12 }, { exists: false, requestId: "r1" });
    await service.writeResource(1, "dach", "stock", "SKU2", { quantity: 4 }, { exists: true, requestId: "r2" });
    const requests = calls.filter((entry) => entry.options);
    assert.equal(requests[0].options.method, "POST");
    assert.equal(requests[0].options.attempts, 1);
    assert.equal(requests[1].options.method, "PATCH");
    assert.equal(requests[1].options.attempts, 1);
    assert.match(requests[0].path, /prices\/SKU%2F1$/);
  });
});

test("preview reads live remote state, persists one-time preview and classifies noop/change", async () => {
  const saved = [];
  clearModule("../src/services/writePreviewService");
  await withLoadStubs({
    "../repositories/catalogRepository": { getCatalogItem: async (_accountId, sku) => ({ sku, title: `Produto ${sku}`, is_present: true }) },
    "../repositories/writeRepository": { findBlockingOperation: async () => null, createPreview: async (value) => { saved.push(value); return { id: "preview-1", expires_at: value.expiresAt }; } },
    "./portfolioReadService": { getPrice: async (_a, _t, sku) => ({ status: 200, data: sku === "A" ? { price: 10, list_price: 12 } : { price: 9, list_price: 12 } }) },
  }, () => require("../src/services/writePreviewService"), async (service) => {
    const account = { id: 7, dach_tenant_id: "dach-7", status: "active", scopes: ["open:portfolio-prices-seller:write"] };
    const result = await service.buildPreview({ account, identity: { dachTenantId: "dach-7", dachUserId: "u-7" }, resource: "price", changes: [
      { sku: "A", price: 10, list_price: 12 },
      { sku: "B", price: 10, list_price: 12 },
    ] });
    assert.equal(result.summary.noop, 1);
    assert.equal(result.summary.changed, 1);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].rows[1].method, "PATCH");
  });
});

test("preview refuses writes when token/account scope is missing", async () => {
  clearModule("../src/services/writePreviewService");
  await withLoadStubs({
    "../repositories/catalogRepository": {}, "../repositories/writeRepository": {}, "./portfolioReadService": {},
  }, () => require("../src/services/writePreviewService"), async (service) => {
    assert.throws(() => service.assertWriteReady({ status: "active", scopes: [] }, "stock"), (error) => error.code === "MAGALU_WRITE_SCOPE_MISSING" && error.status === 403);
  });
});

test("execution blocks stale remote state before any POST/PATCH", async () => {
  let writes = 0;
  const operation = { id: 10, account_id: 7, dach_tenant_id: "dach-7", dach_user_id: "u", resource_type: "stock", sku: "S", status: "queued", before_payload: { quantity: 3 }, requested_payload: { quantity: 5 } };
  const finished = [];
  clearModule("../src/services/writeExecutionService");
  await withLoadStubs({
    "../config/postgres": { withClient: async (fn) => fn({ query: async () => ({ rows: [] }) }) },
    "../repositories/accountRepository": { findAccountById: async () => ({ id: 7, dach_tenant_id: "dach-7", status: "active", scopes: ["open:portfolio-stocks-seller:write"] }) },
    "../repositories/catalogRepository": { upsertStock: async () => {} },
    "../repositories/writeRepository": {
      getOperation: async () => operation,
      acquireOperationLock: async () => async () => {},
      claimOperation: async () => ({ ...operation, status: "running" }),
      finishOperation: async (_id, value) => { finished.push(value); return { ...operation, ...value }; },
      appendAudit: async () => {},
      setOperationAccepted: async () => { throw new Error("must not accept"); },
    },
    "./portfolioReadService": {
      getSku: async () => ({ status: 200, data: { sku: "S" } }),
      getStock: async () => ({ status: 200, data: { quantity: 4 } }),
    },
    "./portfolioWriteService": { writeResource: async () => { writes += 1; } },
  }, () => require("../src/services/writeExecutionService"), async (service) => {
    const result = await service.executeOperation(10);
    assert.equal(writes, 0);
    assert.equal(result.status, "stale");
    assert.equal(finished[0].errorCode, "MAGALU_REMOTE_STATE_CHANGED");
  });
});

test("accepted operation resumes verification without resending remote write", async () => {
  let writes = 0;
  const operation = { id: 11, account_id: 7, dach_tenant_id: "dach-7", dach_user_id: "u", resource_type: "price", sku: "P", status: "accepted", remote_accepted_at: new Date(), before_payload: { price: 10, list_price: 12 }, requested_payload: { price: 11, list_price: 12 } };
  clearModule("../src/services/writeExecutionService");
  await withLoadStubs({
    "../config/postgres": { withClient: async (fn) => fn({ query: async () => ({ rows: [] }) }) },
    "../repositories/accountRepository": { findAccountById: async () => ({ id: 7, dach_tenant_id: "dach-7", status: "active", scopes: ["open:portfolio-prices-seller:write"] }) },
    "../repositories/catalogRepository": { upsertPrice: async () => {} },
    "../repositories/writeRepository": {
      getOperation: async () => operation,
      acquireOperationLock: async () => async () => {},
      finishOperation: async (_id, value) => ({ ...operation, ...value }),
      appendAudit: async () => {},
    },
    "./portfolioReadService": { getPrice: async () => ({ status: 200, data: { price: 11, list_price: 12 } }) },
    "./portfolioWriteService": { writeResource: async () => { writes += 1; } },
  }, () => require("../src/services/writeExecutionService"), async (service) => {
    const result = await service.executeOperation(11);
    assert.equal(writes, 0);
    assert.equal(result.status, "succeeded");
  });
});

test("apply revalidates Hub with WRITE magalu for the account resource before creating operations", async () => {
  let hubArgs = null;
  let created = 0;
  clearModule("../src/controllers/writeController");
  await withLoadStubs({
    "../config/env": { MAGALU_WRITE_ENABLED:true, MAGALU_WRITE_MAX_BATCH_SIZE:50, MAGALU_WRITE_PREVIEW_TTL_SECONDS:300 },
    "../repositories/accountRepository": { findAccountByIdForTenant: async () => ({ id:7, dach_tenant_id:"dach-7", magalu_tenant_id:"magalu-7", status:"active", scopes:["open:portfolio-prices-seller:write"] }) },
    "../repositories/writeRepository": {
      getPreviewForIdentity: async () => ({ id:"pv", account_id:7, resource_type:"price" }),
      createOperationsFromPreview: async () => { created += 1; return { operations:[] }; },
    },
    "../services/writePreviewService": { assertWriteReady: () => true, buildPreview: async () => ({}) },
    "../services/hubResourceAccessService": { checkAccountAccess: async (...args) => { hubArgs = args; return { allow:true }; } },
    "../queues/magaluQueue": { enqueueWriteOperation: async () => ({ id:"j" }) },
    "../services/writePayload": { PRICE_WRITE_SCOPE:"p", STOCK_WRITE_SCOPE:"s", hasScope:()=>true },
  }, () => require("../src/controllers/writeController"), async (controller) => {
    const req = { body:{ preview_id:"pv" }, params:{}, query:{}, magaluIdentity:{ dachTenantId:"dach-7", dachUserId:"u" } };
    const result = {};
    const res = { status(code){ result.status=code; return this; }, json(value){ result.body=value; return value; } };
    await controller.apply(req,res,(error)=>{ if(error) throw error; });
    assert.deepEqual(hubArgs,[req.magaluIdentity,{ id:7, dach_tenant_id:"dach-7", magalu_tenant_id:"magalu-7", status:"active", scopes:["open:portfolio-prices-seller:write"] },{ force:true, action:"WRITE magalu" }]);
    assert.equal(created,1);
    assert.equal(result.status,202);
  });
});

test("dispatching is persisted before remote write and network ambiguity becomes uncertain", async () => {
  const operation = { id: 12, account_id: 7, dach_tenant_id: "dach-7", dach_user_id: "u", resource_type: "stock", sku: "S2", status: "queued", before_payload: { quantity: 3 }, requested_payload: { quantity: 5 }, idempotency_key: "00000000-0000-4000-8000-000000000012" };
  let dispatching = false;
  let finished = null;
  clearModule("../src/services/writeExecutionService");
  clearModule("../src/services/hubResourceAccessService");
  await withLoadStubs({
    "../config/postgres": { withClient: async (fn) => fn({ query: async () => ({ rows: [] }) }) },
    "../repositories/accountRepository": { findAccountById: async () => ({ id: 7, dach_tenant_id: "dach-7", status: "active", scopes: ["open:portfolio-stocks-seller:write"] }) },
    "../repositories/catalogRepository": { upsertStock: async () => {} },
    "../repositories/writeRepository": {
      getOperation: async () => operation,
      acquireOperationLock: async () => async () => {},
      claimOperation: async () => ({ ...operation, status: "running" }),
      setOperationDispatching: async (_id, value) => { dispatching = true; return { ...operation, status: "dispatching", actual_method: value.method, request_id: value.requestId }; },
      finishOperation: async (_id, value) => { finished = value; return { ...operation, ...value }; },
      appendAudit: async () => {},
    },
    "./portfolioReadService": {
      getSku: async () => ({ status: 200, data: { sku: "S2" } }),
      getStock: async () => ({ status: 200, data: { quantity: 3 } }),
    },
    "./portfolioWriteService": { writeResource: async () => { const error = new Error("socket closed"); throw error; } },
    "./hubAccessService": { checkHubAccess: async () => ({ allow: true, reason: "ok" }) },
  }, () => require("../src/services/writeExecutionService"), async (service) => {
    const result = await service.executeOperation(12);
    assert.equal(dispatching, true);
    assert.equal(result.status, "uncertain");
    assert.equal(finished.errorCode, "MAGALU_WRITE_RESULT_UNCERTAIN");
  });
});

test("resumed dispatching operation only verifies and never sends again", async () => {
  let writes = 0;
  const operation = { id: 13, account_id: 7, dach_tenant_id: "dach-7", dach_user_id: "u", resource_type: "stock", sku: "S3", status: "dispatching", actual_method: "PATCH", before_payload: { quantity: 3 }, requested_payload: { quantity: 5 } };
  clearModule("../src/services/writeExecutionService");
  await withLoadStubs({
    "../config/postgres": { withClient: async (fn) => fn({ query: async () => ({ rows: [] }) }) },
    "../repositories/accountRepository": { findAccountById: async () => ({ id: 7, dach_tenant_id: "dach-7", status: "active", scopes: ["open:portfolio-stocks-seller:write"] }) },
    "../repositories/catalogRepository": { upsertStock: async () => {} },
    "../repositories/writeRepository": {
      getOperation: async () => operation,
      acquireOperationLock: async () => async () => {},
      finishOperation: async (_id, value) => ({ ...operation, ...value }),
      appendAudit: async () => {},
    },
    "./portfolioReadService": { getStock: async () => ({ status: 200, data: { quantity: 5 } }) },
    "./portfolioWriteService": { writeResource: async () => { writes += 1; } },
  }, () => require("../src/services/writeExecutionService"), async (service) => {
    const result = await service.executeOperation(13);
    assert.equal(writes, 0);
    assert.equal(result.status, "succeeded");
  });
});

test("reverify endpoint queues verification-only job after a fresh account-resource Hub check even with writes disabled", async () => {
  let queueOptions = null;
  let hubArgs = null;
  clearModule("../src/controllers/writeController");
  await withLoadStubs({
    "../config/env": { MAGALU_WRITE_ENABLED:false, MAGALU_WRITE_MAX_BATCH_SIZE:50, MAGALU_WRITE_PREVIEW_TTL_SECONDS:300 },
    "../repositories/accountRepository": { findAccountByIdForTenant: async () => ({ id:7, dach_tenant_id:"dach-7", magalu_tenant_id:"magalu-7", status:"active", scopes:[] }) },
    "../repositories/writeRepository": {
      getOperationForTenant: async () => ({ id:14, account_id:7, dach_tenant_id:"dach-7", dach_user_id:"u", resource_type:"price", sku:"P2", status:"uncertain" }),
      appendAudit: async () => {},
    },
    "../services/writePreviewService": { assertWriteReady: () => true, buildPreview: async () => ({}) },
    "../services/hubResourceAccessService": { checkAccountAccess: async (...args) => { hubArgs = args; return { allow:true }; } },
    "../queues/magaluQueue": { enqueueWriteOperation: async (_operation, options) => { queueOptions = options; return { id:"verify-job" }; } },
    "../services/writePayload": { PRICE_WRITE_SCOPE:"p", STOCK_WRITE_SCOPE:"s", hasScope:()=>true },
  }, () => require("../src/controllers/writeController"), async (controller) => {
    const req = { body:{}, params:{ operationId:"14" }, query:{}, magaluIdentity:{ dachTenantId:"dach-7", dachUserId:"u" } };
    const result = {};
    const res = { status(code){ result.status=code; return this; }, json(value){ result.body=value; return value; } };
    await controller.reverify(req,res,(error)=>{ if(error) throw error; });
    assert.deepEqual(hubArgs,[req.magaluIdentity,{ id:7, dach_tenant_id:"dach-7", magalu_tenant_id:"magalu-7", status:"active", scopes:[] },{ force:true, action:"WRITE magalu" }]);
    assert.deepEqual(queueOptions,{ reason:"reverify" });
    assert.equal(result.status,202);
    assert.equal(result.body.mode,"verification_only");
  });
});


test("price and stock workers accept verify jobs and execute the same safe operation path", async () => {
  const calls = [];

  for (const [workerPath, processorName, operationId] of [
    ["../src/jobs/priceUpdate.worker", "processPriceUpdateJob", 201],
    ["../src/jobs/stockUpdate.worker", "processStockUpdateJob", 202],
  ]) {
    clearModule(workerPath);
    await withLoadStubs({
      bullmq: { Worker: class Worker {} },
      "../config/redis": { ensureRedisConnected: async () => ({}) },
      "../config/queueNames": { priceUpdate: "magalu:price:update", stockUpdate: "magalu:stock:update" },
      "../services/writeExecutionService": {
        executeOperation: async (id) => {
          calls.push({ workerPath, id });
          return { id, status: "succeeded" };
        },
      },
    }, () => require(workerPath), async (workerModule) => {
      const result = await workerModule._test[processorName]({
        name: "verify",
        data: { operationId, reason: "reverify" },
      });
      assert.equal(result.status, "succeeded");
      assert.equal(result.id, operationId);
    });
  }

  assert.deepEqual(calls.map((entry) => entry.id), [201, 202]);
});

test("write queue names reverify as verify and retries apply/verify up to three attempts", async () => {
  const added = [];
  clearModule("../src/queues/magaluQueue");
  class FakeQueue {
    constructor(name) { this.name = name; }
    async add(name, data, options) {
      added.push({ queue: this.name, name, data, options });
      return { id: `${this.name}-${name}` };
    }
    async close() {}
  }
  await withLoadStubs({
    bullmq: { Queue: FakeQueue },
    "../config/redis": { ensureRedisConnected: async () => ({}) },
    "../config/queueNames": {
      webhookProcess: "magalu:webhook:process",
      tokenRefresh: "magalu:token:refresh",
      catalogSync: "magalu:catalog:sync",
      priceUpdate: "magalu:price:update",
      stockUpdate: "magalu:stock:update",
    },
  }, () => require("../src/queues/magaluQueue"), async (queue) => {
    await queue.enqueueWriteOperation({ id: 301, resource_type: "price" }, { reason: "reverify" });
    await queue.enqueueWriteOperation({ id: 302, resource_type: "stock" });
  });

  assert.equal(added[0].queue, "magalu:price:update");
  assert.equal(added[0].name, "verify");
  assert.equal(added[0].data.reason, "reverify");
  assert.equal(added[0].options.attempts, 3);
  assert.deepEqual(added[0].options.backoff, { type: "exponential", delay: 5000 });
  assert.equal(added[1].queue, "magalu:stock:update");
  assert.equal(added[1].name, "apply");
  assert.equal(added[1].options.attempts, 3);
});

test("worker revalidates Hub immediately before dispatch and denial prevents remote write", async () => {
  const operation = {
    id: 401,
    account_id: 7,
    dach_tenant_id: "dach-7",
    dach_user_id: "user-7",
    resource_type: "stock",
    sku: "HUB-SKU",
    status: "queued",
    before_payload: { quantity: 3 },
    requested_payload: { quantity: 5 },
    idempotency_key: "00000000-0000-4000-8000-000000000401",
  };
  let writes = 0;
  let dispatches = 0;
  let hubArgs = null;
  let finished = null;
  const sequence = [];

  clearModule("../src/services/writeExecutionService");
  clearModule("../src/services/hubResourceAccessService");
  await withLoadStubs({
    "../config/postgres": { withClient: async (fn) => fn({ query: async () => ({ rows: [] }) }) },
    "../repositories/accountRepository": { findAccountById: async () => ({ id: 7, dach_tenant_id: "dach-7", magalu_tenant_id: "magalu-7", status: "active", scopes: ["open:portfolio-stocks-seller:write"], access_token: "must-not-pass" }) },
    "../repositories/catalogRepository": { upsertStock: async () => {} },
    "../repositories/writeRepository": {
      getOperation: async () => operation,
      acquireOperationLock: async () => async () => {},
      claimOperation: async () => ({ ...operation, status: "running" }),
      setOperationDispatching: async () => { dispatches += 1; sequence.push("dispatch"); return { ...operation, status: "dispatching" }; },
      finishOperation: async (_id, value) => { finished = value; return { ...operation, ...value }; },
      appendAudit: async () => {},
    },
    "./portfolioReadService": {
      getSku: async () => { sequence.push("sku-get"); return { status: 200, data: { sku: "HUB-SKU" } }; },
      getStock: async () => { sequence.push("stock-get"); return { status: 200, data: { quantity: 3 } }; },
    },
    "./portfolioWriteService": { writeResource: async () => { writes += 1; sequence.push("write"); } },
    "./hubAccessService": {
      checkHubAccess: async (...args) => {
        sequence.push("hub");
        hubArgs = args;
        return { allow: false, reason: "module_revoked" };
      },
    },
  }, () => require("../src/services/writeExecutionService"), async (service) => {
    const result = await service.executeOperation(operation.id);
    assert.equal(result.status, "failed");
  });

  assert.deepEqual(hubArgs, [
    { dachTenantId: "dach-7", dachUserId: "user-7" },
    { force: true, action: "WRITE magalu", resourceKey: "magalu:magalu-7" },
  ]);
  assert.equal(writes, 0);
  assert.equal(dispatches, 0);
  assert.equal(finished.errorCode, "MAGALU_WRITE_HUB_ACCESS_DENIED");
  assert.deepEqual(sequence, ["sku-get", "stock-get", "hub"]);
});

test("reconciliation ignores disabled write flag and missing write scope and performs GET only", async () => {
  let writes = 0;
  const operation = {
    id: 501,
    account_id: 7,
    dach_tenant_id: "dach-7",
    dach_user_id: "u",
    resource_type: "stock",
    sku: "REC-SKU",
    status: "uncertain",
    actual_method: "PATCH",
    requested_payload: { quantity: 9 },
  };

  clearModule("../src/services/writeExecutionService");
  await withLoadStubs({
    "../config/env": {
      MAGALU_WRITE_ENABLED: false,
      MAGALU_WRITE_VERIFY_ATTEMPTS: 1,
      MAGALU_WRITE_VERIFY_DELAY_MS: 1,
    },
    "../config/postgres": { withClient: async (fn) => fn({ query: async () => ({ rows: [] }) }) },
    "../repositories/accountRepository": { findAccountById: async () => ({ id: 7, dach_tenant_id: "dach-7", status: "active", scopes: [] }) },
    "../repositories/catalogRepository": { upsertStock: async () => {} },
    "../repositories/writeRepository": {
      getOperation: async () => operation,
      acquireOperationLock: async () => async () => {},
      finishOperation: async (_id, value) => ({ ...operation, ...value }),
      appendAudit: async () => {},
    },
    "./portfolioReadService": { getStock: async () => ({ status: 200, data: { quantity: 9 } }) },
    "./portfolioWriteService": { writeResource: async () => { writes += 1; } },
    "./hubAccessService": { checkHubAccess: async () => { throw new Error("Hub must not gate reconciliation-only GET"); } },
  }, () => require("../src/services/writeExecutionService"), async (service) => {
    const result = await service.executeOperation(operation.id);
    assert.equal(result.status, "succeeded");
  });

  assert.equal(writes, 0);
});
