"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { dateWindows, assertFinancialScope, pagePath, syncRange } = require("../src/services/financialAnalysisSyncService");
const api = require("../src/services/magaluApiClient");
const limiter = require("../src/services/magaluRateLimiter");
const repository = require("../src/repositories/financialAnalysisRepository");

test("splits filtered dates into windows of no more than fifteen inclusive days", () => {
  assert.deepEqual(dateWindows("2026-10-01", "2026-10-31"), [
    ["2026-10-01", "2026-10-15"],
    ["2026-10-16", "2026-10-30"],
    ["2026-10-31", "2026-10-31"],
  ]);
  assert.throws(() => dateWindows("2026-10-31", "2026-10-01"), /período/i);
});

test("requires the financial scope on the selected account", () => {
  assert.throws(() => assertFinancialScope({ scopes: [] }), /escopo/i);
  assert.doesNotThrow(() => assertFinancialScope({ scopes: ["open:order-financial-report-seller:read"] }));
});

test("preserves the date filter on every pagination request", () => {
  const path = pagePath("2026-10-01", "2026-10-15", 100);
  const url = new URL(path, "https://example.test");
  assert.equal(url.pathname, "/seller/v1/financial-analysis/orders");
  assert.equal(url.searchParams.get("_offset"), "100");
  assert.match(url.searchParams.get("purchased_at__gte"), /^2026-10-01/);
  assert.match(url.searchParams.get("purchased_at__lte"), /^2026-10-15/);
  assert.equal(url.searchParams.get("purchased_at__lte"), "2026-10-15T23:59:59.999999Z");
});

test("a failed second page persists no partial financial snapshots", async () => {
  const originals = { request: api.request, waitFor: limiter.waitFor, upsert: repository.upsert, upsertBatch: repository.upsertBatch };
  let calls = 0, persisted = 0;
  api.request = async () => {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error("remote failure"), { status: 502 });
    return { data: { results: Array.from({ length: 100 }, (_, i) => ({ external_id: String(i + 1), transactions: [] })), meta: { page: { count: 100 }, links: { next: "/next" } } } };
  };
  limiter.waitFor = async () => {};
  repository.upsert = async () => { persisted += 1; };
  repository.upsertBatch = async () => { persisted += 1; };
  try {
    await assert.rejects(syncRange({ id: 1, dach_tenant_id: "tenant", scopes: ["open:order-financial-report-seller:read"] }, { from: "2026-10-07", to: "2026-10-07" }), /remote failure/);
    assert.equal(calls, 2);
    assert.equal(persisted, 0);
  } finally {
    Object.assign(api, { request: originals.request });
    Object.assign(limiter, { waitFor: originals.waitFor });
    Object.assign(repository, { upsert: originals.upsert, upsertBatch: originals.upsertBatch });
  }
});

test("rejects an empty page that still advertises a next page", async () => {
  const originalRequest = api.request, originalWait = limiter.waitFor, originalBatch = repository.upsertBatch;
  let persisted = false;
  api.request = async () => ({ data: { results: [], meta: { links: { next: "/next" } } } });
  limiter.waitFor = async () => {};
  repository.upsertBatch = async () => { persisted = true; };
  try {
    await assert.rejects(syncRange({ id: 1, dach_tenant_id: "tenant", scopes: ["open:order-financial-report-seller:read"] }, { from: "2026-10-07", to: "2026-10-07" }), /página financeira vazia/i);
    assert.equal(persisted, false);
  } finally {
    api.request = originalRequest;
    limiter.waitFor = originalWait;
    repository.upsertBatch = originalBatch;
  }
});
