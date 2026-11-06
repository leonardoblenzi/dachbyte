"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("janelas do painel usam datas de Sao Paulo e o periodo anterior do mesmo tamanho", () => {
  const { _test } = require("../src/controllers/dashboardController");
  const at = new Date("2026-11-06T02:00:00.000Z"); // 23h de 05/11 em Sao Paulo
  assert.deepEqual(_test.dateWindows(7, at), { current: { from: "2026-10-30", to: "2026-11-05" }, previous: { from: "2026-10-23", to: "2026-10-29" } });
  assert.deepEqual(_test.dateWindows(1, at), { current: { from: "2026-11-05", to: "2026-11-05" }, previous: { from: "2026-11-04", to: "2026-11-04" } });
});

test("estoque em risco considera so produtos que venderam: sem estoque ou ate 15 dias", () => {
  const { _test } = require("../src/controllers/dashboardController");
  const rows = _test.withCoverage([
    { sku: "a", units: 30, revenue: 1000, stock_known: true, stock_quantity: 5 },
    { sku: "b", units: 3, revenue: 200, stock_known: true, stock_quantity: 0 },
    { sku: "c", units: 3, revenue: 90, stock_known: true, stock_quantity: 500 },
    { sku: "d", units: 1, revenue: 50, stock_known: false },
  ]);
  const risk = _test.stockRiskFrom(rows);
  assert.equal(risk.count, 2);
  assert.equal(risk.out_of_stock, 1);
  assert.equal(risk.low_coverage, 1);
  assert.equal(risk.revenue_at_risk, 1200);
  assert.equal(rows.find((row) => row.sku === "a").coverage_days, 5);
});

test("cache do painel expira, separa periodos e e limpo ao renomear a conta", () => {
  const cache = require("../src/services/dashboardCacheService");
  cache.set(9, "7d", { ok: true, n: 1 });
  cache.set(9, "30d", { ok: true, n: 2 });
  assert.equal(cache.get(9, "7d").n, 1);
  assert.equal(cache.get(9, "30d").n, 2);
  cache.invalidateAccount(9);
  assert.equal(cache.get(9, "7d"), null);
  const controller = read("src/controllers/dashboardController.js");
  assert.match(controller, /String\(req\.query\?\.fresh\|\|""\)!=="1"/);
  assert.match(controller, /orders_synced_at/);
  assert.match(read("src/controllers/accountController.js"), /dashboardCache\.invalidateAccount\(accountId\)/);
});

test("painel nao mostra mais sincronizacao nem ultimas alteracoes; mostra margem, ritmo e produtos", () => {
  const html = read("views/app.html");
  const dashboard = html.slice(html.indexOf('id="mg-dashboard"'), html.indexOf('id="mg-catalog-page"'));
  assert.doesNotMatch(dashboard, /Últimas alterações|mg-dashboard-sync-card|Sincronização|Sinais operacionais|mg-dashboard-delivery-statuses/);
  for (const id of ["mg-dashboard-margin-pct", "mg-dashboard-pace-gmv", "mg-dashboard-pace-orders", "mg-dashboard-top-products", "mg-dashboard-stock-risk-count", "mg-dashboard-cancel"]) {
    assert.match(dashboard, new RegExp(`id="${id}"`), id);
  }
  assert.doesNotMatch(dashboard, /50c38028|magalu_tenant_id/);
});

test("ritmo do mes e comparativo seguem a regra do ML", () => {
  const source = read("public/js/magalu-dashboard.js");
  const sandbox = { window: { addEventListener() {} }, document: { getElementById: () => null, querySelector: () => null }, location: { pathname: "/" }, Intl, Number, Math, String, Date, Array, Object, Map, Set, JSON };
  vm.runInNewContext(source, sandbox);
  const { paceModel, variation } = sandbox.window.MagaluDashboard._test;
  const pace = paceModel(73681, 560589, 6, 30);
  assert.equal(pace.status, "behind");
  assert.equal(Math.round(pace.expected), 112118);
  assert.equal(Math.round(pace.projection), 368405);
  assert.equal(variation(110, 100).text, "+10,0%");
  assert.equal(variation(110, 100, { inverse: true }).tone, "negative");
  assert.equal(variation(26.9, 28.5, { mode: "points" }).text, "-1,6 p.p.");
});

test("renomear conta: so administrador, grava apelido local e no Hub", () => {
  const routes = read("src/routes/account.routes.js");
  assert.match(routes, /router\.put\("\/accounts\/:accountId\/name", userAccess\.requireAdmin, accountController\.renameAccount\)/);
  const hub = read("src/services/hubAccountService.js");
  assert.match(hub, /\/v1\/internal\/portal\/accounts\/label/);
  const repo = read("src/repositories/accountRepository.js");
  assert.match(repo, /'\{customer_alias\}'/);
  assert.match(repo, /\? 'customer_alias'\s*then magalu_tenant_name/);
  assert.match(read("public/js/magalu-app.js"), /data-account-rename="\$\{id\}"/);
});
