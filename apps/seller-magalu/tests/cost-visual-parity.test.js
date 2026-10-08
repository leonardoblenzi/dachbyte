"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("Custos por SKU segue a hierarquia operacional do ML sem duplicar controles", () => {
  const html = read("views/app.html");
  const panel = html.split('data-margin-panel="costs"')[1].split('data-margin-panel="summary"')[0];
  const sections = ["mg-cost-status", "mg-cost-toolbar", "mg-rich-kpis", "mg-cost-monitor", "mg-fin-two-col", "mg-cost-filter-card", "mg-cost-table-card"];
  let cursor = -1;
  for (const section of sections) {
    const next = panel.indexOf(section);
    assert.ok(next > cursor, `${section} deve vir após a seção anterior`);
    cursor = next;
  }
  for (const id of ["mg-financial-refresh", "mg-cost-export", "mg-financial-cost-search", "mg-cost-state", "mg-financial-costs-body", "mg-cost-prev", "mg-cost-next"]) {
    assert.equal((panel.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `${id} deve aparecer uma vez`);
  }
  assert.match(panel, /<label[^>]*>\s*<span>Buscar SKU ou produto<\/span>\s*<input id="mg-financial-cost-search"/);
  assert.match(panel, /<label[^>]*>\s*<span>Status do custo<\/span>\s*<select id="mg-cost-state"/);
});

test("estilos de custos são específicos da aba e precedem o CSS canônico", () => {
  const html = read("views/app.html");
  assert.match(html, /magalu-cost-visual-parity\.css[\s\S]*?magalu-canonical-ui\.css/);
  const css = read("public/css/magalu-cost-visual-parity.css");
  assert.match(css, /#mg-financial-margin-page \[data-margin-panel="costs"\]/);
  assert.match(css, /@media\s*\(max-width:\s*760px\)/);
});
