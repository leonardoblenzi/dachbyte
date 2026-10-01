"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const marginHtml = read("views/financeiro-ml-margem.html");
const marginJs = read("public/js/financeiro-ml-margem.js");
const costsJs = read("public/js/financeiro-ml-custos.js");
const shellJs = read("public/js/ml-shell.js");
const routesJs = read("routes/htmlRoutes.js");
const accessJs = read("services/companyAccessService.js");

test("hosts SKU costs inside the margin page and removes the old entry points", () => {
  assert.match(marginHtml, /id="fml-tab-costs"[\s\S]*?>Custos por SKU<\/button>/);
  assert.match(marginHtml, /id="fml-costs-panel"[\s\S]*?id="fml-cost-filters"[\s\S]*?id="fml-cost-body"/);
  assert.match(marginHtml, /\/ml\/js\/financeiro-ml-custos\.js\?v=12/);
  assert.doesNotMatch(shellJs, /financeiro-custos-ml/);
  assert.doesNotMatch(accessJs, /ml\.precificacao\.custos/);
  assert.doesNotMatch(routesJs, /\/financeiro\/custos-mercado-livre/);
  assert.equal(fs.existsSync(path.join(root, "views", "financeiro-ml-custos.html")), false);
  for (const id of [
    "fml-cost-status", "fml-tax-rate", "fml-save-tax", "fml-sync-costs",
    "fml-export-costs", "fml-import-costs", "fml-cost-file", "fml-kpi-total",
    "fml-kpi-filled", "fml-kpi-missing", "fml-kpi-coverage", "fml-kpi-note",
    "fml-cost-insights", "fml-cost-priority", "fml-cost-lookup-type",
    "fml-cost-search", "fml-cost-filter-help", "fml-cost-subtitle",
    "fml-refresh-costs", "fml-cost-prev", "fml-cost-page", "fml-cost-next",
  ]) {
    assert.match(marginHtml, new RegExp(`id="${id}"`), `${id} should remain available`);
  }
  assert.match(marginHtml, /data-risk="margin_risk"/);
  assert.match(marginHtml, /<th>Custo \(R\$\)<\/th>/);
});

test("exposes reusable costs initialization and opens a focused SKU search", () => {
  assert.match(costsJs, /window\.FinanceiroMlCosts\s*=\s*\(\(\)\s*=>/);
  assert.match(costsJs, /function init\(\)/);
  assert.match(costsJs, /function openForSku\(sku\)/);
  assert.match(costsJs, /els\.lookupType\.value\s*=\s*["']sku["']/);
  assert.match(costsJs, /return \{ init, openForSku \}/);
  assert.doesNotMatch(costsJs, /document\.addEventListener\(["']DOMContentLoaded/);
});

test("offers a minimal CMV action and never chooses among multiple missing SKUs", () => {
  assert.match(marginJs, /function missingCostItems\(row = \{\}\)/);
  assert.match(marginJs, /function renderPeriodCostAction\(row\)/);
  assert.match(marginJs, /function openCostForSku\(sku\)/);
  assert.match(marginJs, /function openMissingCostPicker\(items\)/);
  assert.match(marginJs, /fml-period-cost-action/);
});

test("collects only missing-cost order items and groups repeated SKUs", () => {
  const source = marginJs.match(/function missingCostItems\(row = \{\}\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(source, "missing-cost collector should exist");
  const collect = vm.runInNewContext(`(${source})`);
  const items = collect({ order_items: [
    { sku: " A ", title: "Produto A", quantity: 2, has_cost: false },
    { sku: "A", title: "Produto A", quantity: 1, has_cost: false },
    { sku: "B", title: "Produto B", quantity: 3, has_cost: true },
    { sku: "", title: "Sem identificacao", quantity: 1, has_cost: false },
  ] });
  assert.deepEqual(JSON.parse(JSON.stringify(items)), [
    { sku: "A", title: "Produto A", quantity: 3 },
    { sku: "", title: "Sem identificacao", quantity: 1 },
  ]);
});

test("places the cost action below CMV only when the order has a missing SKU cost", () => {
  const source = marginJs.match(/function missingCostItems\(row = \{\}\) \{[\s\S]*?\n  \}/)?.[0];
  const actionSource = marginJs.match(/function renderPeriodCostAction\(row\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(source && actionSource);
  const render = vm.runInNewContext(`${source}\n(${actionSource})`, {
    fmtNum: (value) => String(value),
    escapeHtml: (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;"),
  });
  assert.equal(render({ order_id: "1", order_items: [{ sku: "A", has_cost: true }] }), "");
  assert.match(render({ order_id: "2", order_items: [{ sku: "A", has_cost: false }] }), /1 item sem custo · Cadastrar/);
  assert.match(render({ order_id: "3", order_items: [{ sku: "A", has_cost: false }, { sku: "B", has_cost: false }] }), /2 itens sem custo · Ver custos/);
  assert.match(marginJs, /<td>\$\{fmtMoney\(row\.product_cost\)\}\$\{renderPeriodCostAction\(row\)\}<\/td>/);
});
