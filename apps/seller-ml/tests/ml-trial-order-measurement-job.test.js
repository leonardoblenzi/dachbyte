"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  queueClosedMonthMeasurement,
  processClosedMonthMeasurement,
  runPendingClosedMonthMeasurements,
  requeueFailedClosedMonthMeasurement,
} = require("../services/mlTrialOrderMeasurementJob");

test("measurement migration stores status, source, period and errors per account", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../db/079_ml_closed_month_order_measurements.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ml_closed_month_order_measurements/i);
  for (const column of ["period_start", "period_end_exclusive", "status", "order_count", "source", "measured_at", "error_message"]) {
    assert.match(sql, new RegExp(`\\b${column}\\b`, "i"));
  }
  assert.match(sql, /UNIQUE.*account_id.*period_start/is);
});

test("activation records one durable pending measurement for the previous closed month", async () => {
  const calls = [];
  const db = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; } };
  await queueClosedMonthMeasurement(db, 17, new Date("2026-10-21T12:00:00Z"));
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ON CONFLICT.*DO NOTHING/is);
  assert.deepEqual(calls[0].values, [17, "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
});

test("worker persists measured orders, period and source only after ML confirms a total", async () => {
  const calls = [];
  const db = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (/UPDATE ml_closed_month_order_measurements[\s\S]*RETURNING/i.test(sql)) {
      return { rows: [{ account_id: 17, period_start: "2026-09-01", period_end_exclusive: "2026-10-01", meli_user_id: 123 }] };
    }
    return { rows: [] };
  }, withClient: async (callback) => callback(db) };
  const result = await processClosedMonthMeasurement(db, 17, "2026-09-01", {
    loadCredentials: async () => ({ accessToken: "token", mlCreds: { meli_user_id: "123" } }),
    fetchTotal: async () => 1501,
  });
  assert.equal(result.status, "succeeded", result.error);
  assert.equal(result.rangeCode, "from_1501_to_3000");
  assert.ok(calls.some(({ sql, values }) =>
    /UPDATE meli_contas/i.test(sql) && values.includes(1501) && values.includes("from_1501_to_3000")));
  assert.ok(calls.some(({ sql, values }) =>
    /UPDATE ml_closed_month_order_measurements/i.test(sql) && values.includes("mercado_livre_orders_search")));
});

test("ML failure records failed state and never writes a zero order count", async () => {
  const calls = [];
  const db = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (/UPDATE ml_closed_month_order_measurements[\s\S]*RETURNING/i.test(sql)) {
      return { rows: [{ account_id: 17, period_start: "2026-09-01", period_end_exclusive: "2026-10-01", meli_user_id: 123 }] };
    }
    return { rows: [] };
  } };
  const result = await processClosedMonthMeasurement(db, 17, "2026-09-01", {
    loadCredentials: async () => ({ accessToken: "token", mlCreds: { meli_user_id: "123" } }),
    fetchTotal: async () => { throw new Error("ml_orders_search_429"); },
  });
  assert.equal(result.status, "failed", result.error);
  assert.equal(calls.some(({ sql }) => /UPDATE meli_contas/i.test(sql)), false);
  assert.ok(calls.some(({ sql, values }) =>
    /UPDATE ml_closed_month_order_measurements/i.test(sql) && values.includes("ml_orders_search_429")));
});

test("worker reclaims stale runs and processes the durable pending rows", async () => {
  const calls = [];
  const db = { query: async (sql) => {
    calls.push(sql);
    return /SELECT account_id, period_start/i.test(sql)
      ? { rows: [{ account_id: 17, period_start: "2026-09-01" }] }
      : { rows: [] };
  } };
  const processed = [];
  await runPendingClosedMonthMeasurements(db, {
    processRow: async (accountId, periodStart) => processed.push([accountId, periodStart]),
  });
  assert.ok(calls.some((sql) => /SET status = 'queued'[\s\S]*WHERE status = 'running'/i.test(sql)));
  assert.deepEqual(processed, [[17, "2026-09-01"]]);
});

test("measurement poller runs only when trial onboarding is enabled", () => {
  const worker = fs.readFileSync(path.join(__dirname, "../worker.js"), "utf8");
  assert.match(worker, /SELLER_TRIAL_ONBOARDING_ENABLED[\s\S]*startClosedMonthMeasurementWorker/);
  assert.match(worker, /stopClosedMonthMeasurementWorker/);
});

test("a failed measurement can be retried without creating another trial or overwriting orders", async () => {
  const calls = [];
  const db = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [{ account_id: 17 }] };
  } };
  const result = await requeueFailedClosedMonthMeasurement(db, 17, "2026-09-01");
  assert.equal(result, true);
  assert.ok(calls.some(({ sql, values }) =>
    /SET status = 'queued'[\s\S]*WHERE account_id = \$1[\s\S]*status = 'failed'/i.test(sql) &&
    values[0] === 17 && values[1] === "2026-09-01"));
  assert.equal(calls.some(({ sql }) => /seller_module_trials|UPDATE meli_contas/i.test(sql)), false);
});
