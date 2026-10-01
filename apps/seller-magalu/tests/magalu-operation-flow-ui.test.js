"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("price and stock expose the same explicit SKU selection modes as catalog", () => {
  const html = read("views/app.html");
  const client = read("public/js/magalu-app.js");
  for (const resource of ["price", "stock"]) {
    assert.match(html, new RegExp(`data-operation-resource="${resource}"`));
    assert.match(html, new RegExp(`data-operation-mode="single"`));
    assert.match(html, new RegExp(`data-operation-mode="list"`));
  }
  assert.match(client, /resolveWriteSelection/);
  assert.match(client, /\/magalu\/api\/catalog\/skus/);
  assert.match(client, /String\(row\.sku\) === sku/);
  assert.match(client, /\/magalu\/api\/writes\/preview/);
  assert.doesNotMatch(client, /portfolioWriteService/);
});

test("price and stock keep explicit selection modes separate and accessible", () => {
  const html = read("views/app.html");
  for (const resource of ["price", "stock"]) {
    assert.match(html, new RegExp(`id="mg-${resource}-mode-tabs"[^>]*role="tablist"`));
    assert.match(html, new RegExp(`id="mg-${resource}-mode-single"[^>]*aria-controls="mg-${resource}-single-panel"`));
    assert.match(html, new RegExp(`id="mg-${resource}-mode-list"[^>]*aria-controls="mg-${resource}-list-panel"`));
    assert.match(html, new RegExp(`id="mg-${resource}-single-panel"[^>]*role="tabpanel"`));
    assert.match(html, new RegExp(`id="mg-${resource}-list-panel"[^>]*role="tabpanel"`));
    assert.match(html, new RegExp(`<label for="mg-${resource}-sku-input">SKU</label>`));
    assert.match(html, new RegExp(`<label for="mg-${resource}-sku-list">Lista de SKUs</label>`));
    assert.match(html, /recorte (já )?carregado|itens carregados pelo catálogo/);
  }
});

test("manual selection resolves only the active mode and survives an empty catalog page", () => {
  const client = read("public/js/magalu-app.js");
  assert.match(client, /function activeOperationMode\(resource\)/);
  assert.match(client, /activeOperationMode\(resource\) === "single"/);
  assert.match(client, /const rows = skus\.map\(\(sku\) => candidates\.find/);
  assert.doesNotMatch(client, /if \(!state\.rows\.length\) \{\s*host\.innerHTML/);
});

test("switching accounts clears operation-specific manual selections", () => {
  const client = read("public/js/magalu-app.js");
  assert.match(client, /function clearWriteSelections\(\)/);
  assert.match(client, /state\.writeRows\.price = null;/);
  assert.match(client, /state\.writeRows\.stock = null;/);
  assert.match(client, /function chooseAccount\(accountId\) \{[\s\S]*clearWriteSelections\(\);/);
});

test("price and stock use the catalog-style selection summary before configuration", () => {
  const html = read("views/app.html");
  const client = read("public/js/magalu-app.js");
  for (const resource of ["price", "stock"]) {
    assert.match(html, new RegExp(`data-operation-select="${resource}"`));
    assert.match(html, new RegExp(`id="mg-${resource}-selection-count"`));
    assert.match(html, new RegExp(`id="mg-${resource}-select-loaded"`));
    assert.match(html, new RegExp(`id="mg-${resource}-clear-selection"`));
  }
  assert.match(client, /function updateWriteSelectionSummary\(resource\)/);
});
