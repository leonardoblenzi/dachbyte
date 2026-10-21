"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { processMeasurement, syncMeasurementToHub, queueMissingMeasurements, runPendingMeasurements } =
  require("../src/services/closedMonthOrderMeasurementJob");

const row = { shop_db_id: 4, shop_id: "123", tenant_id: "tenant-1",
  period_start: "2026-09-01", period_end_exclusive: "2026-10-01" };

test("failed Shopee measurement records failure without a range or Hub publish", async () => {
  const statements = [];
  const db = { query: async (sql, values) => {
    statements.push({ sql, values });
    if (sql.includes("SET status = 'running'")) return { rows: [row] };
    return { rows: [] };
  } };
  const result = await processMeasurement(db, 4, "2026-09-01", {
    countOrders: async () => { throw new Error("shopee_orders_list_incomplete"); },
  });
  assert.equal(result.status, "failed");
  assert.equal(statements.some(({ sql }) => sql.includes("SET status = 'failed'")), true);
  assert.equal(statements.some(({ sql }) => sql.includes("SET status = 'succeeded'")), false);
});

test("completed count is persisted with source and only then published to Hub", async () => {
  const statements = [];
  const db = { query: async (sql, values) => {
    statements.push({ sql, values });
    if (sql.includes("SET status = 'running'")) return { rows: [row] };
    if (sql.includes("WHERE m.status = 'succeeded'")) return { rows: [{ ...row, order_count: 3001, source: "shopee_paid_orders_sync" }] };
    return { rows: [] };
  } };
  const result = await processMeasurement(db, 4, "2026-09-01", { countOrders: async () => 3001 });
  assert.deepEqual(result, { status: "succeeded", total: 3001, rangeCode: "contact_sales" });
  const saved = statements.find(({ sql }) => sql.includes("SET status = 'succeeded'"));
  assert.ok(saved);
  assert.equal(saved.values.includes("contact_sales"), true);
  const posted = [];
  await syncMeasurementToHub(db, new Date("2026-10-21T00:00:00Z"), {
    postMeasurement: async (payload) => posted.push(payload),
  });
  assert.deepEqual(posted, [{ tenant_id: "tenant-1", resource_key: "shopee:123", status: "succeeded",
    period_start: "2026-09-01", period_end_exclusive: "2026-10-01",
    order_count: 3001, source: "shopee_paid_orders_sync" }]);
});

test("queue targets only activated trial shops for the current closed month", async () => {
  const statements = [];
  await queueMissingMeasurements({ query: async (sql, values) => { statements.push({ sql, values }); return { rows: [] }; } },
    new Date("2026-10-21T00:00:00Z"));
  assert.match(statements[0].sql, /public_trial_oauth_sessions/);
  assert.match(statements[0].sql, /activated/);
  assert.deepEqual(statements[0].values, ["2026-09-01", "2026-10-01"]);
});

test("worker requeues only aged failed measurements with retries remaining", async () => {
  const statements = [];
  const db = { query: async (sql) => { statements.push(sql); return { rows: [] }; } };
  await runPendingMeasurements(db, new Date("2026-10-21T00:00:00Z"));
  assert.equal(statements.some((sql) => sql.includes("status = 'failed'") &&
    sql.includes("attempts < 10") && sql.includes("INTERVAL '1 hour'")), true);
});
