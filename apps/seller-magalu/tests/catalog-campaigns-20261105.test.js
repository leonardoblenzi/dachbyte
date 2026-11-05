"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

test("Gestão de catálogo mostra custo e exportação XLSX", () => {
  const html = read("views/app.html");
  const js = read("public/js/magalu-sku-management.js");
  const shell = read("public/js/magalu-app.js");
  assert.match(html, /id="mg-sku-export"/);
  assert.match(html, /<th>Preço<\/th><th>Custo<\/th><th>Estoque<\/th>/);
  assert.match(js, /r\.unit_cost/);
  assert.match(js, /\/skus\/export/);
  assert.match(js, /state\.appliedFilters/);
  assert.match(js, /client\.fetchResponse/);
  assert.doesNotMatch(js, /await\s+fetch\(/);
  assert.match(shell, /async function fetchResponse\(url, options = \{\}\)/);
  assert.match(shell, /fetchJson, fetchResponse/);
});

test("XLSX é somente leitura, com autenticação por conta e filtros", () => {
  const routes = read("src/routes/skuManagement.routes.js");
  const controller = read("src/controllers/skuManagementController.js");
  const repository = read("src/repositories/skuMassRepository.js");
  assert.match(routes, /router\.get\("\/skus\/export",controller\.exportSkus\)/);
  assert.match(controller, /async function exportSkus\(req, res\)/);
  assert.match(controller, /const account = await accountFor\(req\)/);
  assert.match(controller, /createXlsx\(/);
  assert.match(repository, /async function exportSkus\(accountId, filters = \{\}\)/);
  assert.match(repository, /catalogWhere\(\{ \.\.\.filters, accountId \}\)/);
  assert.match(repository, /left join magalu\.sku_costs c on c\.account_id=s\.account_id and c\.sku=s\.sku/);
  assert.match(read("src/repositories/skuBulkSelectionRepository.js"), /left join magalu\.sku_costs c on c\.account_id=s\.account_id and c\.sku=s\.sku/);
  assert.match(repository, /limit 100001/);
  assert.match(repository, /rows\.length > 100000/);
});

test("Produtos sai do menu, mas a URL antiga permanece funcional", () => {
  const html = read("views/app.html");
  const routes = read("src/routes/index.js");
  assert.doesNotMatch(html, /data-group="products"/);
  assert.match(routes, /router\.get\("\/catalogo".*\/magalu\/gestao-skus/);
});

test("Campanhas concentra as três abas e preserva URL da antiga precificação", () => {
  const html = read("views/app.html");
  const tabs = read("public/js/magalu-campaign-tabs.js");
  const pricing = read("public/js/magalu-promocoes-massa.js");
  const routes = read("src/routes/index.js");
  assert.match(html, /data-campaigns-tab="pricing"[\s\S]*data-campaigns-tab="available"[\s\S]*data-campaigns-tab="participating"/);
  assert.match(html, /data-campaign-panel="pricing"/);
  assert.doesNotMatch(html, /data-nav-path="\/precificacao-promocional"/);
  assert.match(tabs, /parent\.appendChild\(pricing\)/);
  assert.match(pricing, /magalu:campaignstab/);
  assert.match(routes, /router\.get\("\/precificacao-promocional"[^\n]*\/magalu\/promocoes\?aba=precificacao/);
});
