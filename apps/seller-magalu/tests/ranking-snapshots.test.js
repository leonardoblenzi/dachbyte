"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const rules = require("../src/services/rankingRules");

const NOW = new Date("2026-11-06T15:00:00.000Z");

test("so mes fechado inteiro pode usar foto mensal", () => {
  assert.equal(rules.isClosedMonthRange({ from: "2026-10-01", to: "2026-10-31" }, NOW), true);
  assert.equal(rules.isClosedMonthRange({ from: "2026-11-01", to: "2026-11-30" }, NOW), false, "mes atual nao fechou");
  assert.equal(rules.isClosedMonthRange({ from: "2026-10-02", to: "2026-10-31" }, NOW), false);
  assert.deepEqual(rules.closedMonths(3, NOW), [
    { from: "2026-10-01", to: "2026-10-31" },
    { from: "2026-09-01", to: "2026-09-30" },
    { from: "2026-08-01", to: "2026-08-31" },
  ]);
});

test("ranking vindo da foto usa os totais do mes para a participacao", () => {
  const range = { from: "2026-10-01", to: "2026-10-31" };
  const payload = rules.buildRankingPayload({
    currentRows: [{ sku: "a", units: 2, revenue: 300 }],
    previousRows: [{ sku: "a", units: 1, revenue: 100 }],
    mainRange: range, compareRange: range, orderBy: "faturamento", limit: 10, filters: { q: "", fulfillment: null },
    currentTotals: { revenue: 1000, units: 10, products: 25 }, previousTotals: { revenue: 400, units: 4, products: 9 },
    sources: { main: "snapshot", compare: "snapshot" },
  });
  assert.equal(payload.ranking[0].revenue_share, 0.3);
  assert.equal(payload.summary.revenue_total, 1000);
  assert.equal(payload.meta.products_sold, 25);
  assert.deepEqual(payload.meta.sources, { main: "snapshot", compare: "snapshot" });
});

function loadService(stubs) {
  const id = require.resolve("../src/services/rankingSnapshotService");
  delete require.cache[id];
  const original = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return original.call(this, request, parent, isMain);
  };
  try { return require("../src/services/rankingSnapshotService"); } finally { Module._load = original; }
}

test("worker gera so os meses fechados que faltam, nos dois tipos de ranking", async () => {
  const saved = [];
  const service = loadService({
    "../repositories/rankingRepository": {
      normalizeLimit: (value) => [30, 50, 100].includes(Number(value)) ? Number(value) : 30,
      withAccountLock: async (_id, fn) => fn(),
      getSettings: async () => ({ persist_enabled: true, snapshot_limit: 50 }),
      listSnapshotMonths: async () => [
        { period_start: "2026-10-01", types: 2, snapshot_limit: 50 },
        { period_start: "2026-09-01", types: 2, snapshot_limit: 30 },
      ],
      saveSnapshot: async (accountId, range, type, data) => { saved.push([accountId, range.from, type, data.snapshotLimit, data.rows.length, data.totals.revenue]); return { rows: data.rows.length }; },
    },
    "../repositories/uxAnalyticsRepository": {
      soldSkus: async () => [{ sku: "a", units: 5, revenue: 100 }, { sku: "b", units: 1, revenue: 900 }],
    },
  });
  const result = await service.runForAccount(7, { monthsBack: 3, now: NOW });
  assert.deepEqual(result.generated, ["2026-09", "2026-08"], "outubro ja esta completo; setembro tinha limite menor");
  assert.equal(saved.length, 4);
  assert.deepEqual(saved[0], [7, "2026-09-01", "faturamento", 50, 2, 1000]);
  assert.deepEqual(saved[1].slice(0, 3), [7, "2026-09-01", "quantidade"]);
});

test("engrenagem: config so para admin, rotas e agendador no worker", () => {
  const routes = read("src/routes/api.routes.js");
  assert.match(routes, /router\.get\("\/ranking\/config",rankingController\.getConfig\)/);
  assert.match(routes, /router\.put\("\/ranking\/config",userAccess\.requireAdmin,rankingController\.saveConfig\)/);
  const worker = read("src/worker.js");
  assert.match(worker, /startRankingSnapshotScheduler\(\)/);
  assert.match(worker, /stopRankingSnapshotScheduler\(\)/);
  assert.match(read("db/migrations/020_ranking_snapshots.sql"), /create table if not exists magalu\.ranking_snapshots/);
  assert.match(read("src/repositories/rankingRepository.js"), /create table if not exists magalu\.ranking_snapshot_items/);
  const html = read("views/app.html");
  assert.match(html, /id="mg-ranking-config-btn"/);
  for (const limit of [30, 50, 100]) assert.match(html, new RegExp(`data-ranking-preset="${limit}"`));
  assert.match(html, /id="mg-ranking-persist" type="checkbox"/);
  assert.match(read("public/js/magalu-ranking.js"), /\/magalu\/api\/ranking\/config/);
});
