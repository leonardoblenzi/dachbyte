"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const db = require("../src/config/postgres");
const repository = require("../src/repositories/financialRepository");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

async function captureQuery(run) {
  const original = db.query;
  let captured;
  db.query = async (sql, params) => { captured = { sql, params }; return { rows: [] }; };
  try { await run(); return captured; } finally { db.query = original; }
}

test("custos filtram pelo status da Magalu, estoque e vendas de 90 dias, também na exportação", async () => {
  const filters = { status: "UNPUBLISHED", stock: "with", sales: "sold90" };
  const listing = await captureQuery(() => repository.listCosts(4, filters));
  const exported = await captureQuery(() => repository.exportCosts(4, filters));
  for (const query of [listing, exported]) {
    assert.match(query.sql, /upper\(coalesce\(s\.status,''\)\)=\$2/);
    assert.ok(query.params.includes("UNPUBLISHED"));
    assert.match(query.sql, /from magalu\.stocks st where st\.account_id=s\.account_id and st\.sku=s\.sku and st\.is_present=true and st\.quantity>0/);
    assert.match(query.sql, /interval '90 days'/);
  }
  const without = await captureQuery(() => repository.listCosts(4, { stock: "without" }));
  assert.match(without.sql, /not exists\(select 1 from magalu\.stocks st/);
  const unknown = await captureQuery(() => repository.listCosts(4, { status: "published'; drop" }));
  assert.doesNotMatch(unknown.sql, /upper\(coalesce\(s\.status/);
});

test("listagem de custos traz estoque e unidades vendidas por SKU", async () => {
  const listing = await captureQuery(() => repository.listCosts(4, {}));
  assert.match(listing.sql, /as stock_quantity/);
  assert.match(listing.sql, /as sold_units_90d/);
});

test("tela de custos oferece os status da Magalu e mantém a paginação dentro do card", () => {
  const html = read("views/app.html"), css = read("public/css/magalu-cost-visual-parity.css"), js = read("public/js/magalu-financial.js");
  for (const value of ["PUBLISHED", "UNPUBLISHED", "BLOCKED", "INACTIVE"]) assert.match(html, new RegExp(`<option value="${value}">`));
  assert.match(html, /id="mg-cost-stock-filter"/);
  assert.match(html, /id="mg-cost-sales-filter"/);
  assert.match(html, /id="mg-cost-clear"/);
  assert.match(css, /\.mg-cost-table-card \.mg-pagination \{\s*margin: 0 !important;\s*padding: 14px 20px !important;/);
  assert.match(js, /stock:\$\("mg-cost-stock-filter"\)\?\.value\|\|"",sales:\$\("mg-cost-sales-filter"\)\?\.value\|\|""/);
  assert.match(js, /colspan="10"/);
  assert.doesNotMatch(js, /pct\(r\.tax_rate\)\}\$\{state\.accountTax>0/);
});
