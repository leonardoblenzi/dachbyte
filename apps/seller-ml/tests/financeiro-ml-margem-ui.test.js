"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(
  path.join(__dirname, "..", "views", "financeiro-ml-margem.html"),
  "utf8",
);
const js = fs.readFileSync(
  path.join(__dirname, "..", "public", "js", "financeiro-ml-margem.js"),
  "utf8",
);
const css = fs.readFileSync(
  path.join(__dirname, "..", "public", "css", "financeiro-ml.css"),
  "utf8",
);

test("shows product price between GMV and CMV and the order status at the end of the period table", () => {
  const periodTable = html.match(
    /<table class="fml-table fml-table--margin">([\s\S]*?)<\/table>/,
  )?.[1];

  assert.ok(periodTable, "period margin table should exist");
  assert.match(
    periodTable,
    />GMV\s[\s\S]*?>Preço produto\s[\s\S]*?>CMV\s/,
  );
  assert.equal((periodTable.match(/<th(?:\s|>)/g) || []).length, 18);
  assert.match(periodTable, /Folga\/un\.[\s\S]*?<th>Status<\/th>/);
  assert.match(
    periodTable,
    /valor dos produtos vendidos no pedido, antes de somar o frete pago pelo comprador\. O GMV bruto e formado por este valor mais o frete do comprador/i,
  );
  assert.match(
    periodTable,
    /<tbody id="fml-margin-body">\s*<tr><td colspan="18" class="fml-empty">Carregando margens\.\.\.<\/td><\/tr>\s*<\/tbody>/,
  );
});

test("renders product revenue between GMV and product cost and status for period rows", () => {
  const renderPeriodRows = js.match(
    /function renderPeriodRows\(rows = \[\]\) \{([\s\S]*?)\n  function renderEquilibriumRows/,
  )?.[1];

  assert.ok(renderPeriodRows, "period row renderer should exist");
  assert.match(
    renderPeriodRows,
    /fmtMoney\(row\.gmv\)[\s\S]*?fmtMoney\(row\.product_revenue\)[\s\S]*?fmtMoney\(row\.product_cost\)/,
  );
  const periodRowTemplate = renderPeriodRows.match(
    /return `\s*<tr>([\s\S]*?)<\/tr>`;/,
  )?.[1];
  assert.ok(periodRowTemplate, "period row template should exist");
  assert.equal((periodRowTemplate.match(/<td(?:\s|>)/g) || []).length, 18);
  assert.match(periodRowTemplate, /renderOrderStatus\(row\.lifecycle_status\)/);
  assert.match(
    renderPeriodRows,
    /els\.body\.innerHTML = '<tr><td colspan="18" class="fml-empty">Nenhum pedido encontrado\.<\/td><\/tr>'/,
  );
});

test("uses 18 columns for period loading and error states", () => {
  const loadMargin = js.match(
    /async function loadMargin\(\{ force = false \} = \{\}\) \{([\s\S]*?)\n  document\.addEventListener/,
  )?.[1];

  assert.ok(loadMargin, "margin loader should exist");
  assert.match(
    loadMargin,
    /els\.body\.innerHTML = '<tr><td colspan="18" class="fml-empty">Carregando margens\.\.\.<\/td><\/tr>'/,
  );
  assert.match(
    loadMargin,
    /els\.body\.innerHTML = `<tr><td colspan="18" class="fml-empty">\$\{escapeHtml\(error\.message\)\}<\/td><\/tr>`/,
  );
});

test("keeps the listing status filter separate from the period order status filter", () => {
  assert.match(
    html,
    /<span>Status anúncio<\/span>\s*<select class="fml-input" name="status">/,
  );
  assert.match(
    html,
    /<span>Status pedido<\/span>\s*<select class="fml-input" name="order_status">[\s\S]*?<option value="in_progress">Em andamento<\/option>[\s\S]*?<option value="completed">Concluído<\/option>[\s\S]*?<option value="problem">Problema<\/option>/,
  );
});

test("keeps the equilibrium table at 17 columns", () => {
  const equilibriumTable = html.match(
    /<table class="fml-table fml-table--equilibrium">([\s\S]*?)<\/table>/,
  )?.[1];

  assert.ok(equilibriumTable, "equilibrium table should exist");
  assert.equal((equilibriumTable.match(/<th(?:\s|>)/g) || []).length, 17);
  assert.match(
    equilibriumTable,
    /<tbody id="fml-equilibrium-body">\s*<tr><td colspan="17" class="fml-empty">Carregando precificacao estimada\.\.\.<\/td><\/tr>\s*<\/tbody>/,
  );
});

test("keeps nowrap styles aligned with period result columns", () => {
  const nowrapSelectors = css.match(
    /\/\* Evita quebra de valores monetarios importantes\. \*\/\s*([\s\S]*?)\{\s*white-space:nowrap;/,
  )?.[1];

  assert.ok(nowrapSelectors, "important monetary value nowrap rule should exist");
  assert.deepEqual(
    Array.from(
      nowrapSelectors.matchAll(/\.fml-table--margin td:nth-child\((\d+)\)/g),
      (match) => Number(match[1]),
    ),
    [13, 14, 15, 17],
  );
});

test("bumps the margin assets cache keys", () => {
  assert.match(html, /\/ml\/js\/financeiro-ml-margem\.js\?v=15/);
  assert.match(html, /\/ml\/css\/financeiro-ml\.css\?v=2026090401/);
});
