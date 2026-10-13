"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("Custos Magalu usa a ordem visual e ações principais do Meli", () => {
  const html = read("views/app.html");
  const panel = html.split('data-margin-panel="costs"')[1].split('data-margin-panel="summary"')[0];
  const sections = ["mg-cost-status", "mg-cost-toolbar", "mg-rich-kpis", "mg-cost-monitor", "mg-fin-two-col", "mg-cost-filter-card", "mg-cost-table-card"];
  let previous = -1;
  for (const section of sections) {
    const next = panel.indexOf(section);
    assert.ok(next > previous, `${section} fora de ordem`);
    previous = next;
  }
  for (const id of ["mg-cost-tax", "mg-cost-tax-save", "mg-cost-export", "mg-cost-import", "mg-cost-file", "mg-financial-cost-search", "mg-cost-state", "mg-cost-status-filter", "mg-cost-category", "mg-cost-filter", "mg-financial-costs-body"]) {
    assert.match(panel, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(panel, /mg-fin-status-line/);
  assert.doesNotMatch(panel, /mg-cost-toolbar__copy/);
});

test("fluxos de custo são vinculados no cliente Magalu", () => {
  const js = read("public/js/magalu-financial.js");
  for (const id of ["mg-cost-tax-save", "mg-cost-import", "mg-cost-file", "mg-cost-filter", "mg-cost-status-filter", "mg-cost-category"]) {
    assert.ok(js.includes(id), id);
  }
  assert.match(js, /costs\/import/);
  assert.match(js, /costs\/history/);
  assert.match(js, /row\.unit_cost==null\)return null/);
  assert.match(js, /r\.legacy_tax_rate/);
  assert.match(js, /state\.accountTax>0\?\{\}:\{tax_rate:/);
  assert.match(js, /r\.known_margin_pct!=null&&Number\(r\.known_margin_pct\)<=10/);
  assert.doesNotMatch(js, /\/ml\//);
});

test("filtros de custos são restritos ao catálogo da conta e usam status/categoria reais", async () => {
  const db = require("../src/config/postgres");
  const old = db.query;
  let statement, parameters;
  db.query = async (sql, params) => { statement = sql; parameters = params; return { rows: [] }; };
  try {
    const { listCosts } = require("../src/repositories/financialRepository");
    await listCosts(9, { q: "SKU-1,SKU-2", search_type: "sku", status: "active", category: "CAT-1", limit: 25 });
    assert.match(statement, /s\.account_id=\$1/);
    assert.match(statement, /s\.active=true/);
    assert.match(statement, /s\.category_id/);
    assert.equal(parameters[0], 9);
    assert.ok(parameters.some((value) => String(value).includes("CAT-1")));
  } finally { db.query = old; }
});

test("monitor de custo subindo usa histórico gravado, não um alerta fictício", () => {
  const analytics = read("src/repositories/uxAnalyticsRepository.js");
  assert.match(analytics, /magalu\.sku_cost_history/);
  assert.match(analytics, /cost_up/);
  assert.match(analytics, /count\(\*\) filter\(where unit_cost is not null\)\/count\(\*\)/);
  assert.match(analytics, /attention_count/);
  assert.match(read("views/app.html"), /mg-cost-insight-up/);
});

test("sincronização da aba de custos reutiliza o fluxo oficial do catálogo Magalu", () => {
  const html = read("views/app.html");
  const app = read("public/js/magalu-app.js");
  const financial = read("public/js/magalu-financial.js");
  assert.match(html, /id="mg-financial-refresh"[^>]*data-sync/);
  assert.match(app, /magalu:catalogsynced/);
  assert.match(financial, /magalu:catalogsynced/);
});
