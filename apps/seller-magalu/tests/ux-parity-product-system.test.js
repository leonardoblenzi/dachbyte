"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("Magalu major journeys use one product canvas without importing Seller ML", () => {
  const html = read("views", "app.html");
  const app = read("public", "js", "magalu-app.js");
  for (const token of [
    'class="mg-product-page mg-dashboard-page"',
    'class="mg-orders-page mg-product-page"',
    'class="mg-sku-management mg-product-page"',
    'class="mg-product-page mg-operation-page" data-page="/precos"',
    'class="mg-product-page mg-operation-page" data-page="/estoque"',
  ]) assert.ok(html.includes(token), token);
  assert.match(app, /dataset\.routeKey/);
  assert.match(app, /dataset\.magaluRoute/);
  assert.doesNotMatch(app, /seller-ml|ml-shell|\/ml\//i);
});
