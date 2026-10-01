"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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
const costsJs = fs.readFileSync(
  path.join(sellerMlRoot, "public", "js", "financeiro-ml-custos.js"),
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

function functionSource(source, name) {
  const startPattern = new RegExp(`(?:^|\\n)\\s*function\\s+${name}\\s*\\(`);
  const startMatch = source.match(startPattern);
  assert.ok(startMatch, `${name} source should exist`);
  const afterStart = source.slice(startMatch.index + startMatch[0].length);
  const endIndex = afterStart.search(nextFunction);
  assert.notEqual(endIndex, -1, `${name} source should have a following function`);
  return source.slice(startMatch.index, startMatch.index + startMatch[0].length + endIndex);
}

function renderInlineCostCellForTest(row, savingSkus) {
  const renderer = vm.runInNewContext(
    `(${functionSource(marginJs, "renderInlineCostCell")})`,
    { escapeHtml: (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\"/g, "&quot;") },
  );
  return renderer(row, savingSkus);
}

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
    /^<td[^>]*>\s*\$\{row\.has_cost \? fmtMoney\(row\.product_cost\) : renderInlineCostCell\(row\)\}\s*<\/td>$/,
    "the Custo column should keep saved costs as money and render missing SKU costs inline",
  );
});

test("renders a SKU-wide saving lock into inline editor markup after a re-render", () => {
  const row = { reference_sku: "SKU-LOCK-42" };
  const normalMarkup = renderInlineCostCellForTest(row, new Set());
  const savingMarkup = renderInlineCostCellForTest(row, new Set([row.reference_sku]));

  assert.doesNotMatch(normalMarkup, /data-inline-cost-saving="true"/);
  assert.equal((normalMarkup.match(/\sdisabled(?:\s|=|\/?>)/g) || []).length, 0);
  assert.match(savingMarkup, /data-inline-cost-saving="true"/);
  assert.equal((savingMarkup.match(/\sdisabled(?:\s|=|\/?>)/g) || []).length, 3);
  assert.match(savingMarkup, /fml-inline-cost-input[^>]*\sdisabled(?:\s|=|\/?>)/);
  assert.match(savingMarkup, /fml-inline-cost-history[^>]*\sdisabled(?:\s|=|\/?>)/);
  assert.match(savingMarkup, /fml-inline-cost-save[^>]*\sdisabled(?:\s|=|\/?>)/);
});

test("validates Brazilian monetary input and saves it from the equilibrium Enter key handler", () => {
  const parseMoneyInput = sourceSlice(
    marginJs,
    /(?:^|\n)\s*function\s+parseMoneyInput\s*\(/,
    nextFunction,
    "money input parser",
  );
  assert.match(parseMoneyInput, /return null/);
  assert.match(parseMoneyInput, /replace\([^\n]*\./);
  assert.match(parseMoneyInput, /replace\([^\n]*,/);

  assert.match(
    marginJs,
    /els\.equilibriumBody\?\.addEventListener\(["']keydown["'],\s*async\s*\(event\)\s*=>\s*\{[\s\S]*?event\.key\s*!==\s*["']Enter["'][\s\S]*?event\.preventDefault\(\)[\s\S]*?saveInlineCost\(/,
    "Enter in an inline cost input should save through the delegated equilibrium handler",
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

test("prevents duplicate inline saves while the SKU cost request is in flight", () => {
  const saveInlineCost = sourceSlice(
    marginJs,
    /(?:^|\n)\s*async\s+function\s+saveInlineCost\s*\(/,
    nextTopLevelSection,
    "inline cost save function",
  );
  assert.match(
    saveInlineCost,
    /if\s*\(\s*container\.dataset\.inlineCostSaving\s*===\s*["']true["']\s*\|\|\s*state\.inlineCostSavingSkus\.has\(sku\)\s*\)\s*return/,
    "a second click or Enter must exit while the matching container or SKU is saving",
  );
  assert.match(saveInlineCost, /container\.dataset\.inlineCostSaving\s*=\s*["']true["']/);
  assert.match(saveInlineCost, /input\.disabled\s*=\s*true/);
  assert.match(saveInlineCost, /input\.disabled\s*=\s*false/);
  assert.match(saveInlineCost, /delete\s+container\.dataset\.inlineCostSaving/);
  assert.match(saveInlineCost, /setInlineCostEditorsDisabled\(sku,\s*true\)/);
  assert.match(saveInlineCost, /setInlineCostEditorsDisabled\(sku,\s*false\)/);
});

test("locks every visible inline editor that shares a SKU while its save is in flight", () => {
  assert.match(
    marginJs,
    /inlineCostSavingSkus\s*:\s*new Set\(\)/,
    "inline saves should be coordinated by SKU, not just one DOM container",
  );
  const saveInlineCost = sourceSlice(
    marginJs,
    /(?:^|\n)\s*async\s+function\s+saveInlineCost\s*\(/,
    nextTopLevelSection,
    "inline cost save function",
  );
  assert.match(saveInlineCost, /state\.inlineCostSavingSkus\.has\(sku\)/);
  assert.match(saveInlineCost, /state\.inlineCostSavingSkus\.add\(sku\)/);
  assert.match(saveInlineCost, /state\.inlineCostSavingSkus\.delete\(sku\)/);
  assert.match(marginJs, /function\s+setInlineCostEditorsDisabled\s*\(/);
  assert.match(
    marginJs,
    /querySelectorAll\(["']\[data-inline-cost-sku\]["']\)/,
    "all visible cost editors should be found without interpolating SKU into a selector",
  );
  const setInlineCostEditorsDisabled = sourceSlice(
    marginJs,
    /(?:^|\n)\s*function\s+setInlineCostEditorsDisabled\s*\(/,
    nextFunction,
    "inline cost editor locker",
  );
  assert.match(setInlineCostEditorsDisabled, /editorInput\.disabled\s*=\s*disabled/);
  assert.match(setInlineCostEditorsDisabled, /button\.disabled\s*=\s*disabled/);
});

test("ignores stale margin loads without letting an older request hide a newer overlay", () => {
  assert.match(marginJs, /marginRequestId\s*:\s*0/);
  const loadMargin = sourceSlice(
    marginJs,
    /(?:^|\n)\s*async\s+function\s+loadMargin\s*\(/,
    documentReady,
    "margin loader",
  );
  assert.match(loadMargin, /const\s+marginRequestId\s*=\s*\+\+state\.marginRequestId/);
  assert.match(
    loadMargin,
    /if\s*\(\s*marginRequestId\s*!==\s*state\.marginRequestId\s*\)\s*return false/,
    "a response must be current before it updates margin state or DOM",
  );
  assert.match(
    loadMargin,
    /if\s*\(\s*showLoading\s*\)\s*window\.MLLoadingOverlay\?\.hide\(\)/,
    "every loading request must release its own shared-overlay depth, including stale ones",
  );
});

test("balances overlapping loading overlays without hiding the newer request", () => {
  const saveInlineCost = sourceSlice(
    marginJs,
    /(?:^|\n)\s*async\s+function\s+saveInlineCost\s*\(/,
    nextTopLevelSection,
    "inline cost save function",
  );
  assert.match(
    saveInlineCost,
    /window\.MLLoadingOverlay\?\.hide\(\)/,
    "an inline save must release its own overlay depth",
  );
  const loadMargin = sourceSlice(
    marginJs,
    /(?:^|\n)\s*async\s+function\s+loadMargin\s*\(/,
    documentReady,
    "margin loader",
  );
  assert.match(
    loadMargin,
    /if\s*\(\s*showLoading\s*\)\s*window\.MLLoadingOverlay\?\.hide\(\)/,
    "each overlapping load must release exactly one shared-overlay depth",
  );
});

test("does not overwrite a newer refresh status when an inline-save reload becomes stale", () => {
  const saveInlineCost = sourceSlice(
    marginJs,
    /(?:^|\n)\s*async\s+function\s+saveInlineCost\s*\(/,
    nextTopLevelSection,
    "inline cost save function",
  );
  assert.match(saveInlineCost, /const\s+expectedMarginRequestId\s*=\s*state\.marginRequestId\s*\+\s*1/);
  assert.match(
    saveInlineCost,
    /if\s*\(\s*!refreshed\s*&&\s*expectedMarginRequestId\s*!==\s*state\.marginRequestId\s*\)\s*return/,
    "a stale save-triggered reload should leave the newer request status untouched",
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

test("keeps the SKU history drawer implementation shared and delegates Cost history buttons", () => {
  assert.match(
    skuHistoryJs,
    /fetch\(`\/api\/financeiro-ml\/costs\/\$\{encodeURIComponent\(sku\)\}\/timeline\?days=180`,\s*\{[\s\S]*?credentials:\s*["']include["'][\s\S]*?accept:\s*["']application\/json["'][\s\S]*?cache:\s*["']no-store["']/,
    "shared history should fetch the canonical 180-day timeline without caching",
  );
  assert.match(skuHistoryJs, /fml-history-drawer/);
  [
    "fml-history-summary",
    "fml-history-diagnosis",
    "fml-history-comparisons",
    "fml-history-alerts",
    "fml-history-chart",
    "fml-history-listings",
    "fml-history-events",
  ].forEach((className) => assert.match(skuHistoryJs, new RegExp(className)));
  assert.match(skuHistoryJs, /function\s+escapeHtml\s*\(/);
  assert.doesNotMatch(costsHtml, /id="fml-history-(?:backdrop|drawer|content|close|sku)"/);
  assert.doesNotMatch(costsHtml, /fml-history-backdrop/);
  assert.doesNotMatch(costsJs, /function\s+(?:openHistoryShell|closeHistory|renderHistory|loadHistory)\s*\(/);
  assert.match(
    costsJs,
    /window\.FinanceiroMlSkuHistory\?\.open\(row\?\.dataset\?\.sku\)/,
    "priority history buttons should invoke the shared drawer",
  );
  assert.match(
    costsJs,
    /window\.FinanceiroMlSkuHistory\?\.open\(sku\)/,
    "cost-table history buttons should invoke the shared drawer",
  );
});

test("traps Tab focus inside the open shared SKU history drawer", () => {
  assert.match(skuHistoryJs, /function\s+trapFocus\s*\(/);
  assert.match(skuHistoryJs, /event\.key\s*!==\s*["']Tab["']/);
  assert.match(skuHistoryJs, /drawer\.querySelectorAll\(/);
  assert.match(skuHistoryJs, /event\.shiftKey/);
  assert.match(skuHistoryJs, /first\.focus\(\)/);
  assert.match(skuHistoryJs, /last\.focus\(\)/);
  assert.match(skuHistoryJs, /if\s*\(event\.key\s*===\s*["']Tab["']\)\s*trapFocus\(event\)/);
});

function createHistoryDrawerHarness() {
  class Element {
    constructor(tagName) {
      this.tagName = tagName;
      this.hidden = false;
      this.dataset = {};
      this.listeners = {};
      this.attributes = {};
      this.classList = { add() {}, remove() {} };
      this._innerHTML = "";
    }

    set innerHTML(value) {
      this._innerHTML = value;
      if (this.tagName === "aside") {
        this.skuLabel = new Element("strong");
        this.content = new Element("div");
        this.closeButton = new Element("button");
      }
    }

    get innerHTML() { return this._innerHTML; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    focus() { this.focused = true; }
    querySelector(selector) {
      if (selector === "strong") return this.skuLabel;
      if (selector === ".fml-history-content") return this.content;
      if (selector === ".fml-history-close") return this.closeButton;
      return null;
    }
    querySelectorAll() { return []; }
    getClientRects() { return [1]; }
  }

  const body = new Element("body");
  body.children = [];
  body.append = (...elements) => body.children.push(...elements);
  const document = {
    activeElement: new Element("button"),
    body,
    createElement: (tagName) => new Element(tagName),
    addEventListener() {},
  };
  const pending = [];
  const context = {
    document,
    window: {},
    fetch: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    Intl,
  };
  vm.runInNewContext(skuHistoryJs, context);
  return {
    api: context.window.FinanceiroMlSkuHistory,
    pending,
    get drawer() { return body.children.find((element) => element.tagName === "aside"); },
  };
}

function timelineResponse(sku) {
  return {
    ok: true,
    json: async () => ({ success: true, sku, summary: { diagnosis: `Dados de ${sku}` } }),
  };
}

test("does not let a stale SKU history response overwrite a reopened drawer", async () => {
  const harness = createHistoryDrawerHarness();
  const firstOpen = harness.api.open("SKU-A");
  harness.drawer.closeButton.listeners.click();
  const secondOpen = harness.api.open("SKU-B");

  harness.pending[0].resolve(timelineResponse("SKU-A"));
  await firstOpen;

  assert.equal(harness.drawer.skuLabel.textContent, "SKU-B");
  assert.doesNotMatch(harness.drawer.content.innerHTML, /Dados de SKU-A/);

  harness.pending[1].resolve(timelineResponse("SKU-B"));
  await secondOpen;
  assert.equal(harness.drawer.skuLabel.textContent, "SKU-B");
  assert.match(harness.drawer.content.innerHTML, /Dados de SKU-B/);
});
