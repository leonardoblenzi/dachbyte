"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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
