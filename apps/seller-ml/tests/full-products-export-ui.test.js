"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../public/js/full.js"), "utf8");
const view = fs.readFileSync(path.join(__dirname, "../views/full.html"), "utf8");

test("product export tracks the applied query and current visible rows", () => {
  assert.match(source, /productExportContext/);
  assert.match(source, /function updateProductExportButton\(/);
  assert.match(source, /if \(seq !== state\.requestSeq\) return;/);
});

test("editing the search after loading does not change the export scope", async () => {
  const elements = {
    fullSearch: { value: "MLB123" },
    fullSort: { value: "stock" },
    btnExportFullProducts: { disabled: true },
  };
  const window = {};
  const document = {
    getElementById: (id) => elements[id] || null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const code = source.replace(/\}\)\(\);\s*$/, "window.__fullTest = { state, loadProducts };\n})();");
  vm.runInNewContext(code, {
    window,
    document,
    URLSearchParams,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, items: [{ mlb: "MLB123" }], total_cached: 2 }) }),
  });
  await window.__fullTest.loadProducts();
  elements.fullSearch.value = "MLB999";
  assert.equal(window.__fullTest.state.productExportContext.q, "MLB123");
  assert.equal(window.__fullTest.state.productExportContext.sort, "stock");
  assert.equal(window.__fullTest.state.products.length, 1);
  assert.equal(elements.btnExportFullProducts.disabled, false);
});

test("Products in Full has its own PDF export control and field preferences", () => {
  assert.ok(view.includes('id="btnExportFullProducts"'));
  assert.ok(source.includes('fullProductsPdfExportFields'));
  for (const label of ["Foto", "Produto", "SKU", "MLB", "Estoque Full", "Vendas 7/15/30d", "Faturamento 30d", "Cobertura", "Reposição 30d", "Status"]) {
    assert.ok(source.includes(label), `missing ${label}`);
  }
});

test("PDF preview exports loaded rows, applied filters, and an explicit partial-list warning", async () => {
  const elements = {
    fullSearch: { value: "MLB123" },
    fullSort: { value: "stock" },
    btnExportFullProducts: { disabled: true },
  };
  const writes = [];
  const popup = { document: { open() {}, write: (html) => writes.push(html), close() {} }, focus() {} };
  const window = { open: () => popup };
  const document = {
    getElementById: (id) => elements[id] || null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const code = source.replace(/\}\)\(\);\s*$/, "window.__fullTest = { loadProducts, exportProductsPdf };\n})();");
  vm.runInNewContext(code, {
    window, document, URLSearchParams,
    localStorage: { getItem: () => null },
    fetch: async () => ({ ok: true, json: async () => ({
      ok: true, total_cached: 3, last_synced_at: "2026-10-14T12:00:00Z",
      items: [
        { title: "Primeiro <item>", sku: "SKU<1>", mlb: "MLB123", stock_full: 2 },
        { title: "Segundo item", sku: "SKU-2", mlb: "MLB124", stock_full: 1 },
      ],
    }) }),
  });
  await window.__fullTest.loadProducts();
  elements.fullSearch.value = "unsubmitted";
  window.__fullTest.exportProductsPdf(popup);
  const html = writes.join("");
  assert.ok(html.includes("MLB123"));
  assert.ok(!html.includes("unsubmitted"));
  assert.ok(html.includes("Primeiro &lt;item&gt;"));
  assert.ok(html.includes("SKU&lt;1&gt;"));
  assert.ok(html.indexOf("Primeiro &lt;item&gt;") < html.indexOf("Segundo item"));
  assert.ok(html.includes("2 produtos exibidos"));
  assert.ok(html.includes("3 no cache"));
  assert.ok(html.includes("data-pdf-field-toggle"));
});

test("product and saved-plan previews keep separate column preferences", () => {
  const writes = [];
  const popup = { document: { open() {}, write: (html) => writes.push(html), close() {} }, focus() {} };
  const window = {};
  const document = { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} };
  const code = source.replace(/\}\)\(\);\s*$/, "window.__fullTest = { state, exportProductsPdf, exportPlanPdf };\n})();");
  vm.runInNewContext(code, { window, document, localStorage: { getItem: () => null } });
  window.__fullTest.state.products = [{ title: "Item", mlb: "MLB123" }];
  window.__fullTest.exportProductsPdf(popup);
  const productHtml = writes.pop();
  window.__fullTest.exportPlanPdf({ name: "Carga" }, [], popup, ["mlb"]);
  const planHtml = writes.pop();
  assert.ok(productHtml.includes('const storageKey = "fullProductsPdfExportFields"'));
  assert.ok(planHtml.includes('const storageKey = "fullPdfExportFields"'));
  assert.ok(planHtml.includes("Carga"));
});

test("product PDF reports a blocked popup", () => {
  const errors = [];
  const window = { open: () => null, ML: { toast: (message) => errors.push(message) } };
  const document = { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} };
  const code = source.replace(/\}\)\(\);\s*$/, "window.__fullTest = { state, exportProductsPdf };\n})();");
  vm.runInNewContext(code, { window, document, localStorage: { getItem: () => null } });
  window.__fullTest.state.products = [{ mlb: "MLB123" }];
  window.__fullTest.exportProductsPdf();
  assert.match(errors[0], /Pop-up bloqueado/);
});

test("export button opens a writable tab before rendering the PDF", () => {
  assert.match(source, /btnExportFullProducts"\)\?\.addEventListener\("click", \(\) => \{\s*const win = window\.open\("", "_blank"\);/);
  assert.match(source, /exportProductsPdf\(win\)/);
});
