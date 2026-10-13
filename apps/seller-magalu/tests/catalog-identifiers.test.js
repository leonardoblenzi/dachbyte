"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const db = require("../src/config/postgres");
const costs = require("../src/repositories/financialRepository");
const skus = require("../src/repositories/skuMassRepository");

async function capture(run) {
  const original = db.query;
  const originalOne = db.queryOne;
  const calls = [];
  db.query = async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; };
  db.queryOne = async (sql, params) => { calls.push({ sql, params }); return { total: 0 }; };
  try { await run(); return calls; } finally { db.query = original; db.queryOne = originalOne; }
}

test("cost listing and export filter by EAN and family within the account", async () => {
  for (const search_type of ["ean", "group"]) {
    for (const run of [costs.listCosts, costs.exportCosts]) {
      const calls = await capture(() => run(7, { q: "789123", search_type }));
      const sql = calls.at(-1).sql;
      assert.match(sql, /s\.account_id=\$1/);
      assert.match(sql, search_type === "ean" ? /identifiers/ : /s\.group_id/);
      assert.ok(calls.at(-1).params.includes("789123"));
    }
  }
});

test("catalog management searches all SKUs from one family and EAN", async () => {
  for (const search_type of ["ean", "group"]) {
    const calls = await capture(() => skus.listSkus(7, { q: "789123", search_type }));
    assert.match(calls[0].sql, search_type === "ean" ? /identifiers/ : /s\.group_id/);
    assert.ok(calls[0].params.includes("789123"));
  }
});

test("preview of all filtered SKUs preserves the identifier search mode", () => {
  const root = path.resolve(__dirname, "..");
  const js = fs.readFileSync(path.join(root, "public/js/magalu-sku-management.js"), "utf8");
  assert.match(js, /function filters\(\)[^\n]*search_type:/);
  assert.match(js, /function selection\(\)[^\n]*mode:"all_filtered", filters:filters\(\)/);
});

test("cost screen exposes identifiers and both search modes", () => {
  const root = path.resolve(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "views/app.html"), "utf8");
  const js = fs.readFileSync(path.join(root, "public/js/magalu-financial.js"), "utf8");
  assert.match(html, /<th>Identificador<\/th>/);
  assert.match(html, /<option value="ean">EAN<\/option>/);
  assert.match(html, /<option value="group">Família<\/option>/);
  assert.match(js, /r\.ean/);
  assert.match(js, /r\.group_id/);
});

test("identifier cell places family below EAN without a blank row", () => {
  const js = fs.readFileSync(path.resolve(__dirname, "../public/js/magalu-financial.js"), "utf8");
  const source = js.match(/  function identifierCell\(r\)\{[^\n]+/)[0];
  const cell = vm.runInNewContext(`${source}; identifierCell`, { esc: String });
  const full = cell({ sku: "SKU-1", ean: "7890123456789", group_id: "FAM-1" });
  assert.match(full, /<code>SKU-1<\/code><small[^>]*>EAN 7890123456789<\/small><small[^>]*>Família FAM-1<\/small>/);
  const partial = cell({ sku: "SKU-2", group_id: "FAM-2" });
  assert.match(partial, /<code>SKU-2<\/code><small[^>]*>Família FAM-2<\/small>/);
});
