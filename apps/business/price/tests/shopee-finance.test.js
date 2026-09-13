"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createFeeResponse } = require("../src/routes/finance.routes");

const auth = { tenantId: "tenant-1", userId: "user-1" };
const internalOrderId = "c5a4fc36-bc7d-4b41-8d86-4fcfb3f6d1e8";

async function invoke(handler, { orderId = internalOrderId, body = {} } = {}) {
  let payload;
  let error;
  await handler({ vpAuth: auth, params: { orderId }, body }, { json(value) { payload = value; return value; } }, (value) => { error = value; }, "shopee");
  return { payload, error };
}

test("consulta escrow da loja ligada ao pedido interno, sem usar connectionId do corpo", async () => {
  const calls = [];
  const handler = createFeeResponse({
    resolveShopeeConnectionForOrderFn: async () => ({ order: { marketplace_order_id: "SP-ORDER-A" }, connection: { id: "connection-shop-a" } }),
    cachedFeeFn: async (...args) => { calls.push(["cache", ...args]); return null; },
    shopeeOrderFees: async (...args) => { calls.push(["escrow", ...args]); return { channel: "shopee", orderId: "SP-ORDER-A", summary: { commissionFee: 12 }, raw: {} }; },
    saveFeeSnapshotFn: async () => ({ snapshot: { id: "snapshot-1" }, created: true }),
  });
  const { payload, error } = await invoke(handler, { body: { connectionId: "connection-shop-b" } });
  assert.equal(error, undefined);
  assert.deepEqual(calls, [["cache", auth, "shopee", "SP-ORDER-A", 6, "connection-shop-a"], ["escrow", auth, "SP-ORDER-A", "connection-shop-a"]]);
  assert.equal(payload.financialSnapshot.id, "snapshot-1");
});

test("resolve a conta antes de servir escrow Shopee do cache", async () => {
  let cacheRead = false;
  const handler = createFeeResponse({
    resolveShopeeConnectionForOrderFn: async () => { throw Object.assign(new Error("Loja ausente"), { statusCode: 409, code: "shopee_order_account_missing" }); },
    cachedFeeFn: async () => { cacheRead = true; return { id: "cached" }; },
  });
  const { error } = await invoke(handler);
  assert.equal(error.code, "shopee_order_account_missing");
  assert.equal(error.statusCode, 409);
  assert.equal(cacheRead, false);
});

test("rejeita order_sn externo no endpoint financeiro Shopee", async () => {
  let resolved = false;
  const handler = createFeeResponse({ resolveShopeeConnectionForOrderFn: async () => { resolved = true; } });
  const { error } = await invoke(handler, { orderId: "240801ABC123" });
  assert.equal(error.code, "shopee_order_id_invalid");
  assert.equal(error.statusCode, 400);
  assert.equal(resolved, false);
});