"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const { _test: dash } = require("../src/controllers/dashboardController");
const orders = require("../src/repositories/orderRepository");

const NOW = new Date("2026-11-09T15:00:00Z"); // 12:00 em São Paulo

test("período personalizado compara com o período anterior de mesmo tamanho", () => {
  const period = dash.customPeriod("2026-11-01", "2026-11-07", NOW);
  assert.equal(period.key, "custom:2026-11-01:2026-11-07");
  assert.equal(period.days, 7);
  assert.equal(period.label, "01/11/2026 a 07/11/2026");
  assert.deepEqual(period.windows.current, { from: "2026-11-01", to: "2026-11-07" });
  assert.deepEqual(period.windows.previous, { from: "2026-10-25", to: "2026-10-31" });
  const single = dash.customPeriod("2026-11-09", "2026-11-09", NOW);
  assert.deepEqual(single.windows.previous, { from: "2026-11-08", to: "2026-11-08" });
  assert.equal(single.label, "09/11/2026");
});

test("período personalizado recusa datas futuras, invertidas, inválidas ou acima de 90 dias", () => {
  assert.equal(dash.customPeriod("2026-11-05", "2026-11-10", NOW), null);
  assert.equal(dash.customPeriod("2026-11-07", "2026-11-01", NOW), null);
  assert.equal(dash.customPeriod("2026-11-1", "2026-11-07", NOW), null);
  assert.equal(dash.customPeriod("2026-07-01", "2026-11-07", NOW), null);
  assert.ok(dash.customPeriod("2026-08-12", "2026-11-09", NOW));
  assert.throws(() => dash.resolvePeriod({ period: "custom", from: "x", to: "y" }, NOW), /Período personalizado inválido/);
  assert.equal(dash.resolvePeriod({ period: "14d" }, NOW).key, "14d");
  assert.equal(dash.resolvePeriod({ period: "qualquer" }, NOW).key, "7d");
});

test("sincronização do personalizado lê o período atual e o anterior", () => {
  const period = dash.customPeriod("2026-11-01", "2026-11-07", NOW);
  assert.deepEqual(dash.syncRangeFor(period), { from: "2026-10-25", to: "2026-11-07" });
  assert.deepEqual(dash.syncRangeFor("7d", NOW), { from: "2026-10-25", to: "2026-11-09" });
});

test("estatísticas de pedidos aceitam intervalo de datas no fuso de São Paulo", () => {
  const range = orders._test.orderWindow(7, 0, { from: "2026-11-01", to: "2026-11-07" });
  assert.match(range.sql, /\(\(\$2::date\)::timestamp at time zone 'America\/Sao_Paulo'\)/);
  assert.match(range.sql, /\(\(\(\$3::date\)\+1\)::timestamp at time zone 'America\/Sao_Paulo'\)/);
  assert.deepEqual(range.params, ["2026-11-01", "2026-11-07"]);
  const rolling = orders._test.orderWindow(7, 7, null);
  assert.deepEqual(rolling.params, [7, 7]);
});

test("Painel tem o botão Personalizado após 30 dias e aplica com carregamento completo", () => {
  const html = read("views/app.html"), app = read("public/js/magalu-app.js"), controller = read("src/controllers/dashboardController.js");
  assert.match(html, /data-period="30d" type="button">30 dias<\/button><button data-period="custom" id="mg-dashboard-custom-toggle"/);
  assert.match(html, /id="mg-dashboard-from" type="date"/);
  assert.match(html, /id="mg-dashboard-to" type="date"/);
  assert.match(app, /state\.dashboardPeriod = `custom:\$\{from\}:\$\{to\}`;/);
  assert.match(app, /void loadDashboard\(\{ force: true \}\);/);
  assert.match(app, /return custom \? \{ period: "custom", from: custom\.from, to: custom\.to \} : \{ period \};/);
  assert.match(controller, /period\.custom\?orderRepository\.stats\(account\.id,period\.days,0,period\.windows\.previous\)/);
});
