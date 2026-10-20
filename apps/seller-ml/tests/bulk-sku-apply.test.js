"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { planSkuPayload, applyGroup, applyJob } = require("../services/bulkSkuService");

test("variation update preserves all variation IDs and unchanged attributes", () => {
  const item = { id: "MLB123456", seller_id: 99, variations: [
    { id: 1, attributes: [{ id: "GTIN", value_name: "07891234567890" }, { id: "SELLER_SKU", value_name: "OLD" }] },
    { id: 2, attributes: [{ id: "SELLER_SKU", value_name: "OTHER" }] },
  ] };
  const plan = planSkuPayload(item, [{ variation_id: "1", old_sku: "OLD", new_sku: "NEW", row_number: 2 }], 99);
  assert.deepEqual(plan.readyRows.map((row) => row.row_number), [2]);
  assert.deepEqual(plan.body.variations.map((row) => String(row.id)), ["1", "2"]);
  assert.deepEqual(plan.body.variations[0].attributes, [{ id: "GTIN", value_name: "07891234567890" }, { id: "SELLER_SKU", value_name: "NEW" }]);
  assert.equal(plan.body.variations[1].attributes, undefined);
  assert.equal(item.variations[0].attributes[1].value_name, "OLD");
});

test("worker persists verified result and does not process finished jobs again", async () => {
  const updates = [];
  let status = "queued";
  const client = { query: async (sql, params) => {
    if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: true }] };
    if (/select \* from ml\.bulk_sku_jobs/.test(sql)) return { rows: [{ id: "job-1", account_key: "12", status }], rowCount: 1 };
    if (/select \* from ml\.bulk_sku_job_rows/.test(sql)) return { rows: [{ mlb: "MLB123456", variation_id: "", old_sku: "OLD", new_sku: "NEW", row_number: 2, state: "ready" }], rowCount: 1 };
    if (/update ml\.bulk_sku_job_rows/.test(sql)) updates.push(params);
    if (/status = 'finished'/.test(sql)) status = "finished";
    return { rows: [], rowCount: 0 };
  } };
  const db = { withClient: async (fn) => fn(client) };
  let sku = "OLD";
  let writes = 0;
  const ml = { get: async () => ({ id: "MLB123456", seller_id: 99, attributes: [{ id: "SELLER_SKU", value_name: sku }] }), request: async () => { writes += 1; sku = "NEW"; } };
  const deps = { db, ml, loadCredentials: async () => ({ accessToken: "token", mlCreds: { meli_user_id: 99 } }) };
  await applyJob("job-1", deps);
  await applyJob("job-1", deps);
  assert.equal(writes, 1);
  assert.equal(updates[0][2], "applied");
  assert.equal(status, "finished");
});

test("application verifies the changed SKU and never sends stale rows", async () => {
  let item = { id: "MLB123456", seller_id: 99, variations: [
    { id: 1, attributes: [{ id: "SELLER_SKU", value_name: "OLD" }] },
    { id: 2, attributes: [{ id: "SELLER_SKU", value_name: "CHANGED" }] },
  ] };
  let writes = 0;
  const ml = {
    get: async () => item,
    request: async (_path, options) => {
      writes += 1;
      assert.deepEqual(options.body.variations.map((v) => String(v.id)), ["1", "2"]);
      item = { ...item, variations: item.variations.map((v) => String(v.id) === "1" ? { ...v, attributes: [{ id: "SELLER_SKU", value_name: "NEW" }] } : v) };
    },
  };
  const rows = [{ variation_id: "1", old_sku: "OLD", new_sku: "NEW", row_number: 2 }, { variation_id: "2", old_sku: "OLD2", new_sku: "NEW2", row_number: 3 }];
  const result = await applyGroup("MLB123456", rows, { sellerId: 99, accessToken: "token" }, ml);
  assert.equal(writes, 1);
  assert.deepEqual(result.map((r) => r.state), ["applied", "stale"]);
});

test("stale or foreign rows never enter the outgoing payload", () => {
  const item = { id: "MLB123456", seller_id: 99, attributes: [{ id: "SELLER_SKU", value_name: "CHANGED" }] };
  const row = { variation_id: "", old_sku: "OLD", new_sku: "NEW", row_number: 2 };
  assert.deepEqual(planSkuPayload(item, [row], 99).staleRows, [row]);
  assert.equal(planSkuPayload(item, [row], 99).body, null);
  assert.throws(() => planSkuPayload(item, [row], 100), /outra conta/);
});
