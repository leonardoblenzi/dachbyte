"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "views/app.html"), "utf8");
const client = fs.readFileSync(path.join(root, "public/js/magalu-financial.js"), "utf8");

test("period table preserves Magalu financial components without an operational column", () => {
  const period = html.match(/data-margin-panel="period"[\s\S]*?id="mg-margin-missing-cost-dialog"/)?.[0] || "";
  assert.match(period, /mg-margin-data-table/);
  for (const name of ["Envio", "Comissões", "Frete", "Descontos", "Subsídios", "Tarifas", "Repasse", "Resultado", "Margem", "Equilíbrio/un."]) assert.ok(period.includes(`<th>${name}</th>`), name);
  assert.doesNotMatch(period, /<th>Operacional<\/th>/);
});

test("period financial data loads only when the user applies filters", () => {
  assert.match(client, /async function applyMarginFilters\(\)[\s\S]*?margins\/sync/);
  assert.match(client, /financial_report_present/);
  assert.match(client, /"Sem relatório"/);
  assert.match(client, /amount\(r\.tax_base,costComplete\)/);
  assert.match(client, /async function applyMarginFilters\(\)\{\s*if\(!selectedGuard\(\)\)return;/);
  assert.match(client, /loading:"none"/);
  assert.match(client, /async function ux\(path\)\{return shell\(\)\.fetchJson\(`\/magalu\/api\/ux-analytics\$\{path\}`,\{loading:"none"\}\);\}/);
});
