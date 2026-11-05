"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("catalog navigation keeps one protected management entry and the legacy redirect", () => {
  const html = read("views", "app.html");
  const routes = read("src", "routes", "index.js");

  assert.match(html, /href="\/magalu\/gestao-skus"[^>]*>Gestão de catálogo<\/a>/);
  assert.doesNotMatch(html, /data-group="products"/);
  assert.match(routes, /router\.get\("\/catalogo"[^\n]*\/magalu\/gestao-skus/);
});

test("catalog management requires selection and action before protected preview", () => {
  const html = read("views", "app.html");
  const sku = read("public", "js", "magalu-sku-management.js");

  for (const token of ["Inserir SKU", "Colar lista", "Escolha a ação", "id=\"mg-sku-review\"", "Catálogo de apoio"]) {
    assert.ok(html.includes(token), token);
  }
  assert.match(sku, /function selectAction\(action\)/);
  assert.match(sku, /makePreview\(state\.action\)/);
});
