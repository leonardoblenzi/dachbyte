"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");

test("financial pages stay in the canonical Magalu shell and label estimates", () => {
  const html = fs.readFileSync(path.join(root, "views", "app.html"), "utf8");
  const shell = fs.readFileSync(path.join(root, "public", "js", "magalu-app.js"), "utf8");
  assert.match(html, /Precificação<\/strong><small>Custos, margem e preço/);
  assert.match(html, /data-margin-panel="costs"/);
  assert.match(html, /data-page="\/margem"/);
  assert.match(html, /data-page="\/calculadora"/);
  assert.match(html, /Resultado conhecido/);
  assert.match(html, /Comissão, tarifa e frete Magalu não entram/i);
  assert.match(html, /magalu-financial\.js/);
  assert.match(shell, /"\/calculadora": \{ title: "Calculadora"/);
});

test("financial API is isolated under Magalu routes", () => {
  const api = fs.readFileSync(path.join(root, "src", "routes", "api.routes.js"), "utf8");
  const routes = fs.readFileSync(path.join(root, "src", "routes", "financial.routes.js"), "utf8");
  assert.match(api, /router\.use\("\/financial", financialRoutes\)/);
  assert.match(routes, /router\.post\("\/calculator\/calculate"/);
  assert.match(routes, /router\.put\("\/costs\/:sku"/);
});
