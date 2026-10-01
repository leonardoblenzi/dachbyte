"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sellerMlRoot = path.join(__dirname, "..");
const marginHtml = fs.readFileSync(
  path.join(sellerMlRoot, "views", "financeiro-ml-margem.html"),
  "utf8",
);
const costsHtml = fs.readFileSync(
  path.join(sellerMlRoot, "views", "financeiro-ml-custos.html"),
  "utf8",
);
const marginJs = fs.readFileSync(
  path.join(sellerMlRoot, "public", "js", "financeiro-ml-margem.js"),
  "utf8",
);
const skuHistoryPath = path.join(
  sellerMlRoot,
  "public",
  "js",
  "financeiro-ml-sku-history.js",
);
const skuHistoryJs = fs.existsSync(skuHistoryPath)
  ? fs.readFileSync(skuHistoryPath, "utf8")
  : "";

function sourceSlice(source, startPattern, endPattern, label) {
  const startMatch = source.match(startPattern);
  assert.ok(startMatch, `${label} should exist`);
  const fromStart = source.slice(startMatch.index + startMatch[0].length);
  const endIndex = fromStart.search(endPattern);
  assert.notEqual(endIndex, -1, `${label} should have an end marker`);
  return fromStart.slice(0, endIndex);
}

const nextFunction = /\n\s*(?:async\s+)?function\s+\w+\s*\(/;
const documentReady = /\n\s*document\s*\.\s*addEventListener\s*\(/;
const nextTopLevelSection = /\n\s*(?:(?:async\s+)?function\s+\w+\s*\(|document\s*\.\s*addEventListener\s*\()/;

test("renders an editable inline cost cell for every equilibrium SKU", () => {
  const renderInlineCostCell = sourceSlice(
    marginJs,
    /(?:^|\n)\s*function\s+renderInlineCostCell\s*\(/,
    nextFunction,
    "inline cost cell renderer",
  );
  assert.match(renderInlineCostCell, /fml-inline-cost-input/);
  assert.match(renderInlineCostCell, /fml-inline-cost-history/);
  assert.match(renderInlineCostCell, /fml-inline-cost-save/);
  const skuVariable = renderInlineCostCell.match(
    /(?:const|let)\s+(\w+)\s*=\s*[^;\n]*row\.reference_sku/,
  )?.[1];
  assert.ok(skuVariable, "inline cost cell should derive its SKU from row.reference_sku");
  assert.ok(
    new RegExp(
      String.raw`data-inline-cost-sku\s*=\s*["'][^"']*\$\{\s*(?:escapeHtml\(\s*)?${skuVariable}\s*\)?\s*\}[^"']*["']`,
    ).test(renderInlineCostCell),
    "inline cost cell should bind its row reference SKU into data-inline-cost-sku",
  );

  const renderEquilibriumRows = sourceSlice(
    marginJs,
    /(?:^|\n)\s*function\s+renderEquilibriumRows\s*\(/,
    nextFunction,
    "equilibrium row renderer",
  );
  const equilibriumRowTemplate = renderEquilibriumRows.match(
    /return `\s*<tr>([\s\S]*?)<\/tr>`/,
  )?.[1];
  assert.ok(equilibriumRowTemplate, "equilibrium row template should exist");
  const equilibriumCells = equilibriumRowTemplate.match(/<td(?:\s[^>]*)?>[\s\S]*?<\/td>/g) || [];
  assert.equal(equilibriumCells.length, 17, "equilibrium row should retain 17 cells");
  assert.match(
    equilibriumCells[5],
    /^<td[^>]*>\s*\$\{renderInlineCostCell\(row\)\}\s*<\/td>$/,
    "the Custo column should use the inline renderer even when a cost is missing",
  );
});

test("saves inline SKU costs through the canonical endpoint and refreshes without replacing rows first", () => {
  const saveInlineCost = sourceSlice(
    marginJs,
    /(?:^|\n)\s*async\s+function\s+saveInlineCost\s*\(/,
    nextTopLevelSection,
    "inline cost save function",
  );
  assert.ok(
    /fetch\(mlUrl\(`\/api\/financeiro-ml\/costs\/\$\{encodeURIComponent\(sku\)\}`\),\s*\{[\s\S]*?method:\s*["']POST["']/.test(saveInlineCost),
    "inline save should POST to the canonical SKU cost endpoint",
  );
  assert.ok(
    /Salvando custo e recalculando margens\.\.\./.test(saveInlineCost),
    "inline save should show the recalculation overlay message",
  );
  assert.ok(
    /await\s+loadMargin\(\{\s*preservePages:\s*true,\s*retainOnError:\s*true,\s*showLoading:\s*false\s*\}\)/.test(saveInlineCost),
    "inline save should await a refresh that preserves pagination and visible rows without another loading overlay",
  );

  const loadMargin = sourceSlice(
    marginJs,
    /(?:^|\n)\s*async\s+function\s+loadMargin\s*\(/,
    documentReady,
    "margin loader",
  );
  assert.ok(
    /if\s*\(\s*!retainOnError\s*\)\s*\{[\s\S]*?els\.equilibriumBody\.innerHTML\s*=\s*'(?=[^']*Carregando precificacao estimada)[^']*'/.test(loadMargin),
    "the pre-refresh equilibrium loading write should be gated when rows are retained",
  );
});

test("loads the shared SKU history module in cost and margin views", () => {
  const historyScript = /\/ml\/js\/financeiro-ml-sku-history\.js(?:\?[^"'\s>]*)?/;

  assert.ok(historyScript.test(costsHtml), "cost view should load the shared history module");
  assert.ok(historyScript.test(marginHtml), "margin view should load the shared history module");
  assert.ok(fs.existsSync(skuHistoryPath), "shared SKU history module should exist");
  assert.match(
    skuHistoryJs,
    /window\.FinanceiroMlSkuHistory\s*=\s*\{\s*open\s*\}/,
  );
});
