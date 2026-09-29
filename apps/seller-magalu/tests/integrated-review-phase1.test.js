"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("catalog navigation separates consultation from protected operations", () => {
  const html = read("views", "app.html");
  const app = read("public", "js", "magalu-app.js");

  assert.match(html, /href="\/magalu\/catalogo"[^>]*>Consulta de catálogo<\/a>/);
  assert.match(html, /href="\/magalu\/gestao-skus"[^>]*>Gestão de catálogo<\/a>/);
  assert.match(app, /"\/catalogo": \{ title: "Consulta de catálogo", page: "mg-catalog-page", group: "products" \}/);
  assert.match(app, /"\/gestao-skus": \{ title: "Gestão de catálogo", page: "mg-sku-management-page", group: "operations" \}/);
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
