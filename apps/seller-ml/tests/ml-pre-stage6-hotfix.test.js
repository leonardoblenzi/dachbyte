"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..", "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("ranking mensal usa advisory lock preso a mesma sessao", () => {
  const source = read("apps/seller-ml/routes/mercadolivreRankingRoutes.js");
  assert.match(source, /withPgAdvisoryLock/);
  assert.match(
    source,
    /return withPgAdvisoryLock\("ml_ranking_monthly_snapshots", fn\)/,
  );
  const functionSlice = source.slice(
    source.indexOf("async function withSnapshotAdvisoryLock"),
    source.indexOf("async function runDueMonthlySnapshots"),
  );
  assert.doesNotMatch(functionSlice, /db\.query\([^)]*pg_(?:try_)?advisory_(?:lock|unlock)/);
});

test("estrategicos usa advisory lock preso a mesma sessao", () => {
  const source = read("apps/seller-ml/services/estrategicosService.js");
  assert.match(source, /withPgAdvisoryLock/);
  const start = source.indexOf("async function reviewDueRounds");
  const end = source.indexOf("function csvEscape", start);
  const functionSlice = source.slice(start, end);
  assert.match(
    functionSlice,
    /withPgAdvisoryLock\("ml_strategic_due_reviews"/,
  );
  assert.doesNotMatch(functionSlice, /pg_(?:try_)?advisory_(?:lock|unlock)/);
});

test("Hub billing gate tem timeout e production fail-closed por default", () => {
  const source = read("apps/seller-ml/app.js");
  assert.match(source, /isProductionRuntime\(\) \? "strict" : "hybrid"/);
  assert.match(source, /HUB_REQUEST_TIMEOUT_MS/);
  assert.match(source, /ML_HUB_GATE_TIMEOUT_MS/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(
    source,
    /fetchHubWithTimeout\(`\$\{hubBaseUrl\}\/v1\/access\/check`/,
  );
});

test("results do seller-ml estao ignorados e possuem comando de limpeza do indice", () => {
  const gitignore = read(".gitignore");
  const cleanup = read("apps/seller-ml/scripts/untrack-legacy-results.js");
  assert.match(gitignore, /apps\/seller-ml\/results\//);
  assert.match(cleanup, /git/);
  assert.match(cleanup, /--cached/);
  assert.match(cleanup, /apps\/seller-ml\/results/);
});
