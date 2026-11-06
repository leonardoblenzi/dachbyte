"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const { _test } = require("../src/controllers/rankingController");

const NOW = new Date("2026-11-06T15:00:00.000Z");

test("periodos e comparacoes seguem as mesmas opcoes do ranking do ML", () => {
  const month = _test.resolveMainRange({}, NOW);
  assert.deepEqual(month, { from: "2026-11-01", to: "2026-11-06" });
  assert.deepEqual(_test.resolveCompareRange({}, month, NOW), { from: "2026-10-26", to: "2026-10-31" });
  assert.deepEqual(_test.resolveCompareRange({ compararCom: "mes_anterior" }, month, NOW), { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(_test.resolveMainRange({ periodo: "ultimos_7_dias" }, NOW), { from: "2026-10-31", to: "2026-11-06" });
  assert.deepEqual(_test.resolveMainRange({ periodo: "trimestre" }, NOW), { from: "2026-10-01", to: "2026-11-06" });
  const quarter = _test.resolveMainRange({ periodo: "trimestre" }, NOW);
  assert.deepEqual(_test.resolveCompareRange({ compararCom: "trimestre_anterior" }, quarter, NOW), { from: "2026-07-01", to: "2026-09-30" });
  assert.deepEqual(_test.resolveMainRange({ periodo: "personalizado", dataInicio: "2026-10-10", dataFim: "2026-10-01" }, NOW), { from: "2026-10-01", to: "2026-10-10" });
  assert.throws(() => _test.resolveMainRange({ periodo: "personalizado" }, NOW), /datas válidas/);
  assert.equal(_test.clampRange("2024-01-01", "2026-11-06").from, "2025-11-06", "periodo limitado a 366 dias");
});

test("posicao, movimento, status, saidas e sinais", () => {
  const range = { from: "2026-11-01", to: "2026-11-06" };
  const payload = _test.buildRankingPayload({
    currentRows: [
      { sku: "a", title: "Sofá A", units: 5, revenue: 500 },
      { sku: "b", title: "Mesa B", units: 1, revenue: 900, fulfillment: true },
      { sku: "c", title: "Cadeira C", units: 2, revenue: 100 },
    ],
    previousRows: [
      { sku: "a", title: "Sofá A", units: 2, revenue: 100 },
      { sku: "c", title: "Cadeira C", units: 9, revenue: 950 },
      { sku: "d", title: "Rack D", units: 1, revenue: 300 },
    ],
    mainRange: range, compareRange: range, orderBy: "faturamento", limit: 2, filters: { q: "", fulfillment: null },
  });
  assert.deepEqual(payload.ranking.map((row) => [row.sku, row.position, row.previous_position, row.performance_status]), [["b", 1, null, "Novo no ranking"], ["a", 2, 3, "Crescendo"]]);
  assert.deepEqual(payload.exited_ranking.map((row) => row.sku), ["c", "d"]);
  assert.equal(payload.summary.revenue_total, 1500);
  assert.equal(payload.summary.best_up.sku, "a");
  assert.ok(payload.insights.some((item) => item.title === "Saiu do ranking"));
  assert.ok(payload.insights.some((item) => /Concentração Top 2/.test(item.title)));

  const byUnits = _test.buildRankingPayload({ currentRows: [{ sku: "a", units: 5, revenue: 500 }, { sku: "b", units: 1, revenue: 900 }], previousRows: [], mainRange: range, compareRange: range, orderBy: "quantidade", limit: 10, filters: { q: "", fulfillment: null } });
  assert.equal(byUnits.ranking[0].sku, "a");
  const onlyFull = _test.buildRankingPayload({ currentRows: [{ sku: "a", units: 5, revenue: 500 }, { sku: "b", units: 1, revenue: 900, fulfillment: true }], previousRows: [], mainRange: range, compareRange: range, orderBy: "faturamento", limit: 10, filters: { q: "", fulfillment: true } });
  assert.deepEqual(onlyFull.ranking.map((row) => row.sku), ["b"]);
});

test("status segue a regra do ML", () => {
  assert.equal(_test.performanceStatus({ previous_position: null, position: 1 }), "Novo no ranking");
  assert.equal(_test.performanceStatus({ previous_position: 2, position: 6, revenue_delta_percent: -30 }), "Perdendo força");
  assert.equal(_test.performanceStatus({ previous_position: 3, position: 3, revenue_delta_percent: -8 }), "Atenção");
  assert.equal(_test.performanceStatus({ previous_position: 3, position: 3, revenue_delta_percent: 2 }), "Estável");
});

test("tela de ranking: rota, menu, permissao por modulo e visual do Magalu", () => {
  assert.match(read("src/routes/api.routes.js"), /router\.get\("\/ranking",rankingController\.ranking\)/);
  assert.match(read("src/services/userAccessService.js"), /key: "magalu\.visao\.ranking", label: "Ranking de anúncios", group: "Visão geral", path: "\/ranking"/);
  assert.match(read("src/routes/index.js"), /"\/ranking"/);
  const html = read("views/app.html");
  assert.match(html, /data-nav-path="\/ranking"/);
  assert.match(html, /id="mg-ranking-page" class="mg-product-page mg-ranking-page" data-page="\/ranking"/);
  for (const option of ["ultimos_7_dias", "mes_atual", "ultimos_30_dias", "trimestre", "semestre", "personalizado", "mes_anterior", "trimestre_anterior", "semestre_anterior"]) assert.match(html, new RegExp(`value="${option}"`));
  assert.match(html, /data-order="quantidade"/);
  assert.match(html, /<option value="100">Top 100<\/option>/);
  const css = read("public/css/magalu-ranking.css");
  assert.doesNotMatch(css.replace(/\.mg-ranking-thumb\{[^}]*\}/, ""), /#[0-9a-f]{3,6}\b(?![^{]*--mg)/i, "cores vem das variaveis do tema (claro/escuro)");
  assert.match(read("public/js/magalu-ranking.js"), /\/magalu\/api\/ranking\?/);
});
