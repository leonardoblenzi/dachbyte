"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  reconcileCompletedQueueJob,
  sameCsvExportRequest,
  shouldSupersedeOpenJob,
} = require("../services/filtroJobReconciliation");

test("recovers a completed query when rows were persisted", () => {
  const result = reconcileCompletedQueueJob({
    queueState: "completed",
    status: "processando",
    kind: "query",
    persistedTotal: 39297,
  });

  assert.equal(result.status, "concluido");
  assert.equal(result.total, 39297);
});

test("recovers a completed CSV export from its ready manifest", () => {
  const result = reconcileCompletedQueueJob({
    queueState: "completed",
    status: "processando",
    kind: "csv_export",
    persistedTotal: null,
    csvManifest: { ready: true, rows: 133 },
  });

  assert.equal(result.status, "concluido");
  assert.equal(result.total, 133);
  assert.equal(result.downloadReady, true);
});

test("keeps a just-completed job in the metadata grace period", () => {
  const now = Date.now();
  const result = reconcileCompletedQueueJob({
    queueState: "completed",
    status: "processando",
    finishedOn: now - 5000,
    now,
    graceMs: 30000,
  });

  assert.equal(result, null);
});

test("terminates an orphaned completed job instead of leaving it at 100 percent", () => {
  const now = Date.now();
  const result = reconcileCompletedQueueJob({
    queueState: "completed",
    status: "processando",
    finishedOn: now - 60000,
    now,
    graceMs: 30000,
  });

  assert.equal(result.status, "erro");
  assert.match(result.error, /nao foram persistidos/i);
});

test("does not alter active or already terminal jobs", () => {
  assert.equal(reconcileCompletedQueueJob({
    queueState: "active",
    status: "processando",
  }), null);
  assert.equal(reconcileCompletedQueueJob({
    queueState: "completed",
    status: "concluido",
  }), null);
});

test("a new filter supersedes queries but preserves CSV exports", () => {
  assert.equal(shouldSupersedeOpenJob({ kind: "query" }), true);
  assert.equal(shouldSupersedeOpenJob({ kind: "" }), true);
  assert.equal(shouldSupersedeOpenJob({ kind: "csv_export" }), false);
});

test("detects duplicate exports by source job and selected fields", () => {
  assert.equal(sameCsvExportRequest(
    { sourceJobId: "167", fields: ["mlb", "sku"] },
    { sourceJobId: "167", fields: ["mlb", "sku"] },
  ), true);
  assert.equal(sameCsvExportRequest(
    { sourceJobId: "167", fields: ["mlb"] },
    { sourceJobId: "168", fields: ["mlb"] },
  ), false);
  assert.equal(sameCsvExportRequest(
    { sourceJobId: "167", fields: ["mlb"] },
    { sourceJobId: "167", fields: ["mlb", "sku"] },
  ), false);
});
