"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { jobKey, runMarginFreshSync } = require("../src/services/marginFreshSyncService");

const account = { id: 2, status: "active", scopes: [
  "open:order-order-seller:read",
  "open:order-delivery-seller:read",
  "open:order-financial-report-seller:read",
] };

test("fresh margin sync validates the period before calling remote sources", async () => {
  let calls = 0;
  await assert.rejects(runMarginFreshSync({ account, from: "2026-10-15", to: "2026-10-08", orders: async () => { calls++; } }), /período|invertido/i);
  assert.equal(calls, 0);
});

test("fresh margin sync requires all read scopes", async () => {
  await assert.rejects(runMarginFreshSync({ account: { ...account, scopes: [] }, from: "2026-10-08", to: "2026-10-14" }), /scope|escopo/i);
});

test("fresh margin sync completes orders before financial reports and records stages", async () => {
  const events = [];
  const result = await runMarginFreshSync({ account, from: "2026-10-08", to: "2026-10-14",
    orders: async () => { events.push("orders"); return { scanned: 18, failed: 0 }; },
    finance: async () => { events.push("finance"); return { fetched: 15, persisted: 15 }; },
    progress: async stage => { events.push(stage.stage); },
  });
  assert.deepEqual(events, ["orders", "orders", "financial", "finance", "complete"]);
  assert.deepEqual(result, { orders: 18, reports: 15 });
});

test("fresh margin sync rejects a partial order read instead of reporting fresh data", async () => {
  await assert.rejects(runMarginFreshSync({ account, from: "2026-10-08", to: "2026-10-14",
    orders: async () => ({ scanned: 18, failed: 1 }), finance: async () => { throw new Error("must not run"); },
  }), /parcial/i);
});

test("active job identity is stable by account and dates", () => {
  assert.equal(jobKey(2, "2026-10-08", "2026-10-14"), jobKey(2, "2026-10-08", "2026-10-14"));
  assert.notEqual(jobKey(2, "2026-10-08", "2026-10-14"), jobKey(3, "2026-10-08", "2026-10-14"));
});

test("margin sync has a queued route and an account-scoped status route", () => {
  const root = path.resolve(__dirname, "..");
  const routes = fs.readFileSync(path.join(root, "src/routes/uxAnalytics.routes.js"), "utf8");
  const controller = fs.readFileSync(path.join(root, "src/controllers/uxAnalyticsController.js"), "utf8");
  const worker = fs.readFileSync(path.join(root, "src/jobs/ordersSync.worker.js"), "utf8");
  assert.match(routes, /router\.get\("\/margins\/sync\/:jobId",controller\.marginSyncStatus\)/);
  assert.match(controller, /job\.data\.accountId/);
  assert.match(worker, /margin-range-sync/);
});
