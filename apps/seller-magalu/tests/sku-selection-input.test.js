"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const repository = require("../src/repositories/skuMassRepository");

test("explicit SKU input accepts lines, commas and semicolons while preserving first occurrence", () => {
  const actual = repository._test.normalizeExplicitSkus([
    "  SKU-01, SKU-02;SKU-03\nSKU-02  ",
    "SKU-04",
    "",
  ]);

  assert.deepEqual(actual, ["SKU-01", "SKU-02", "SKU-03", "SKU-04"]);
});

test("explicit SKU input removes empty values and constrains each identifier", () => {
  const actual = repository._test.normalizeExplicitSkus([" , ; \n ", "  ABC-123  "]);
  assert.deepEqual(actual, ["ABC-123"]);
  assert.ok(actual.every((sku) => sku.length <= 64));
});

test("catalog management exposes filters, one SKU and pasted list modes through the guarded resolver", () => {
  const root = path.resolve(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "views/app.html"), "utf8");
  const client = fs.readFileSync(path.join(root, "public/js/magalu-sku-management.js"), "utf8");
  const routes = fs.readFileSync(path.join(root, "src/routes/skuManagement.routes.js"), "utf8");
  assert.match(html, /data-sku-input-mode="filters"/);
  assert.match(html, /data-sku-input-mode="single"/);
  assert.match(html, /data-sku-input-mode="list"/);
  assert.match(html, /id="mg-sku-list-input"/);
  assert.match(client, /\/selection\/resolve/);
  assert.match(routes, /router\.post\("\/selection\/resolve",controller\.resolveSelection\)/);
});
