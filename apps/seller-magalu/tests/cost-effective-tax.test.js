"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("consultas de custos usam taxa global quando positiva e legada caso contrário", () => {
  const financial = read("src/repositories/financialRepository.js");
  const analytics = read("src/repositories/uxAnalyticsRepository.js");
  for (const source of [financial, analytics]) {
    assert.match(source, /magalu\.finance_settings/);
    assert.match(source, /coalesce\(nullif\(f\.aliquota,0\),c\.tax_rate,0\)/);
  }
  assert.match(financial, /legacy_tax_rate/);
  assert.match(analytics, /marginOrderCte/);
  assert.match(analytics, /equilibrium/);
});

test("API Magalu expõe taxa global e histórico sem depender de rotas ML", () => {
  const routes = read("src/routes/financial.routes.js");
  const controller = read("src/controllers/financialController.js");
  for (const endpoint of ['router.get("/tax"', 'router.put("/tax"', 'router.get("/costs/history/:sku"']) {
    assert.ok(routes.includes(endpoint), endpoint);
  }
  assert.match(controller, /financialRepository\.saveAccountTax/);
  assert.match(controller, /financialRepository\.getCostHistory/);
  assert.doesNotMatch(controller, /\/ml\//);
});

test("calculadora manual inicia com alíquota global da conta sem bloquear ajuste manual", () => {
  const client = read("public/js/magalu-financial.js");
  assert.match(client, /function loadCalculatorAccountTax/);
  assert.match(client, /route\(\)==="\/calculadora"/);
  assert.match(client, /mg-fin-tax/);
});
