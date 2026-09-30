"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("main Magalu routes expose the common hero and filter primitives", () => {
  const html = read("views/app.html");
  const css = read("public/css/magalu-rich-workspaces.css");

  for (const page of ["mg-catalog-page", "mg-orders-page", "mg-accounts-page", "mg-sync-page"]) {
    assert.match(html, new RegExp(`id="${page}"[\\s\\S]{0,1000}mg-page-hero`), page);
  }

  assert.match(css, /\.mg-filter-card\{[\s\S]*min-height:42px/);
  assert.match(css, /\.mg-filter-grid\{[\s\S]*gap:12px/);
});

test("protected workbenches retain their stages below a common page hero", () => {
  const html = read("views/app.html");
  assert.match(html, /id="mg-price-page"[\s\S]*mg-page-hero[\s\S]*data-operation-resource="price"/);
  assert.match(html, /id="mg-stock-page"[\s\S]*mg-page-hero[\s\S]*data-operation-resource="stock"/);
  assert.match(html, /id="mg-sku-management-page"[\s\S]*mg-page-hero[\s\S]*mg-sku-workspace/);
});
