"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { _test } = require("../src/controllers/projectionController");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const NOW = new Date("2026-11-06T15:00:00.000Z");

test("mes atual, passado e futuro no fuso de Sao Paulo", () => {
  const current = _test.monthInfo("", NOW);
  assert.deepEqual([current.key, current.dayOfMonth, current.daysInMonth, current.isCurrent], ["2026-11", 6, 30, true]);
  assert.equal(_test.previousMonthKey(current), "2026-10");
  assert.equal(_test.monthInfo("2026-10", NOW).dayOfMonth, 31, "mes fechado conta todos os dias");
  assert.equal(_test.monthInfo("2026-12", NOW).isFuture, true);
  assert.equal(_test.previousMonthKey(_test.monthInfo("2026-01", NOW)), "2025-12");
  assert.equal(_test.monthInfo("lixo", NOW).key, "2026-11");
});

test("projecao, comparativos ate o mesmo dia e medias so com dias fechados (regra do ML)", () => {
  const info = _test.monthInfo("", NOW), prev = _test.monthInfo("2026-10", NOW);
  const p = _test.buildProjection({
    info, previousInfo: prev,
    currentRows: [{ day: "2026-11-01", orders: 2, revenue: 1000 }, { day: "2026-11-06", orders: 1, revenue: 500 }],
    previousRows: [{ day: "2026-10-01", orders: 3, revenue: 900 }, { day: "2026-10-20", orders: 1, revenue: 100 }],
    units: 4, statusRows: [{ status: "finished", orders: 3, revenue: 1500 }, { status: "cancelled", orders: 1, revenue: 300 }],
    fulfillment: { full: { orders: 1, revenue: 500 }, other: { orders: 2, revenue: 1000 } },
    statuses: ["finished", "approved", "new"], available: [],
  });
  assert.equal(p.totals.projected, 7500, "(1500 / 6) x 30");
  assert.equal(p.totals.closed_days, 5);
  assert.equal(p.totals.avg_revenue_closed, 200, "hoje fica fora da media");
  assert.equal(p.previous.comparable_revenue, 900, "mes anterior ate o dia 6");
  assert.equal(p.previous.revenue, 1000);
  assert.equal(p.series.daily.length, 30);
  assert.equal(p.series.previous_daily.length, 31);
  assert.deepEqual(p.composition.by_status.map((row) => [row.status, row.counted]), [["finished", true], ["cancelled", false]]);
});

test("tela Projecao mensal em Visao geral com filtro pelos status que a API traz", () => {
  assert.match(read("src/routes/api.routes.js"), /router\.get\("\/projection",projectionController\.projection\)/);
  assert.match(read("src/services/userAccessService.js"), /key: "magalu\.visao\.projecao", label: "Projeção mensal", group: "Visão geral", path: "\/projecao"/);
  const html = read("views/app.html");
  assert.match(html, /data-nav-path="\/projecao"/);
  assert.match(html, /id="mg-projection-page" class="mg-product-page mg-dashboard-page mg-projection-page" data-page="\/projecao"/);
  assert.match(html, /id="mg-proj-status-options"/);
  assert.doesNotMatch(html.slice(html.indexOf('id="mg-projection-page"'), html.indexOf('id="mg-ranking-page"')), /Product Ads|ROAS|TACOS/, "sem blocos de Ads do ML");
  const controller = read("src/controllers/projectionController.js");
  assert.match(controller, /availableStatuses/);
  assert.match(controller, /filter\(\(status\) => !CANCELLED\.has\(status\)\)/, "padrao: todos menos cancelado");
  assert.match(read("public/js/magalu-projection.js"), /finished: "Finalizado"/);
});
