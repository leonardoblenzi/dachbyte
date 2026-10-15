"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const db = require("../src/config/postgres");
const repository = require("../src/repositories/financialRepository");

async function captureQuery(run) {
  const original = db.query;
  let captured;
  db.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try { await run(); return captured; }
  finally { db.query = original; }
}

test("XLSX applies all currently supported cost filters, without paginating the export", async () => {
  const filters = { q: "sofá", search_type: "product", state: "missing", status: "active", category: "CAT-1" };
  const listing = await captureQuery(() => repository.listCosts(9, filters));
  const exported = await captureQuery(() => repository.exportCosts(9, filters));
  for (const fragment of ["s.account_id=$1", "s.is_present=true", "lower(coalesce(s.title,'')) like", "c.unit_cost is null", "s.active=true", "s.category_id="]) {
    assert.ok(listing.sql.includes(fragment), `list missing ${fragment}`);
    assert.ok(exported.sql.includes(fragment), `export missing ${fragment}`);
  }
  assert.deepEqual(exported.params, listing.params.slice(0, -2));
  assert.match(exported.sql, /order by s\.sku asc limit 50001/);
  assert.doesNotMatch(exported.sql, /offset \$/i);
});

test("XLSX keeps SKU-list, inactive, risk, and healthy filter semantics", async () => {
  for (const state of ["risk", "healthy"]) {
    const filters = { q: "SKU-1,SKU-2", search_type: "sku", state, status: "inactive" };
    const listing = await captureQuery(() => repository.listCosts(3, filters));
    const exported = await captureQuery(() => repository.exportCosts(3, filters));
    assert.match(exported.sql, /lower\(s\.sku\)=any\(/);
    assert.match(exported.sql, /s\.active=false/);
    assert.match(exported.sql, /c\.unit_cost is not null/);
    assert.deepEqual(exported.params, listing.params.slice(0, -2));
  }
});

test("browser and controller forward the applied filters to the XLSX query", () => {
  const root = path.join(__dirname, "..");
  const browser = fs.readFileSync(path.join(root, "public/js/magalu-financial.js"), "utf8");
  const controller = fs.readFileSync(path.join(root, "src/controllers/financialController.js"), "utf8");
  assert.match(browser, /function exportCosts\(\)[^\n]*state\.costFilters/);
  assert.match(controller, /financialRepository\.exportCosts\(account\.id,req\.query\)/);
});

test("the page loads a fresh financial script URL after changing export behavior", () => {
  const html = fs.readFileSync(path.join(__dirname, "../views/app.html"), "utf8");
  assert.match(html, /magalu-financial\.js\?v=2026101501/);
});
