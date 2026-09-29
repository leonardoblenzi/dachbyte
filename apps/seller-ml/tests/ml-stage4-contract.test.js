"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("worker inicia retencao de dados junto da retencao Bull", () => {
  const source = read("worker.js");
  assert.match(source, /startBullRetentionScheduler\(\)/);
  assert.match(source, /startDataRetentionScheduler\(\)/);
  assert.match(source, /stopDataRetentionScheduler\(\)/);
});

test("Hub Usage tem lock distribuido, cache diario e timeout HTTP", () => {
  const source = read("services/hubUsageReporter.js");
  assert.match(source, /withPgAdvisoryLock\("ml_hub_usage_reporter"/);
  assert.match(source, /hub_usage_report_cache/);
  assert.match(source, /AbortController/);
  assert.match(source, /HUB_USAGE_REPORT_CACHE_TTL_MS/);
  assert.match(source, /unnest\(\$1::text\[\]\)/);
});

test("schedulers menores usam lock PostgreSQL preso a mesma sessao", () => {
  for (const rel of [
    "services/reputacaoSnapshotScheduler.js",
    "services/mercadolivreSkuPriceHistoryScheduler.js",
    "services/automationReportSchedulerService.js",
  ]) {
    const source = read(rel);
    assert.match(source, /withPgAdvisoryLock/);
    assert.doesNotMatch(source, /db\.query\(`select pg_try_advisory_lock/);
  }
});

test("migration 073 cria cache e indices para limpeza", () => {
  const sql = read("db/073_hub_usage_cache_and_retention_indexes.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ml\.hub_usage_report_cache/i);
  assert.match(sql, /idx_reputation_snapshots_snapshot_date/i);
  assert.match(sql, /idx_ml_sku_sync_runs_created/i);
  assert.match(sql, /ix_ml_ranking_snapshots_periodo_fim/i);
  assert.match(sql, /ix_ml_stock_watch_events_created/i);
});

test("package expoe teste da etapa 4", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts["test:stage4-data"]);
});
