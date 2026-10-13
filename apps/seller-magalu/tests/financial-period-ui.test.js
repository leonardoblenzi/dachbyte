"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "views/app.html"), "utf8");
const client = fs.readFileSync(path.join(root, "public/js/magalu-financial.js"), "utf8");

test("period table presents Magalu financial components without an operational column", () => {
  const period = html.match(/data-margin-panel="period"[\s\S]*?<\/table>/)?.[0] || "";
  for (const name of ["Produto", "Modo de envio", "Comissões Magalu", "Frete", "Cupons e descontos", "Subsídios", "Tarifas Magalu", "Resultado", "Margem", "Equilíbrio est./un.", "Folga/un."]) assert.ok(period.includes(name), name);
  assert.doesNotMatch(period, /<th>Operacional<\/th>/);
});

test("period financial data loads only when the user applies filters", () => {
  assert.match(client, /async function applyMarginFilters\(\)[\s\S]*?margins\/sync/);
  assert.match(client, /financial_report_present/);
  assert.match(client, /Sem relatório financeiro/);
  assert.match(client, /money\(r\.tax_base\)/);
  assert.match(client, /async function applyMarginFilters\(\)\{if\(!selectedGuard\(\)\)return;/);
  assert.match(client, /loading:"none"/);
  assert.match(client, /async function ux\(path\)\{return shell\(\)\.fetchJson\(`\/magalu\/api\/ux-analytics\$\{path\}`,\{loading:"none"\}\);\}/);
});
