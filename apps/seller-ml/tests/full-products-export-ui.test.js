"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../public/js/full.js"), "utf8");

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
