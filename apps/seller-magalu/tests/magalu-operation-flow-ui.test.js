"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("price and stock expose the same explicit SKU selection modes as catalog", () => {
  const html = read("views/app.html");
  const client = read("public/js/magalu-app.js");
  for (const resource of ["price", "stock"]) {
    assert.match(html, new RegExp(`data-operation-resource="${resource}"`));
    assert.match(html, new RegExp(`data-operation-mode="single"`));
    assert.match(html, new RegExp(`data-operation-mode="list"`));
  }
  assert.match(client, /resolveWriteSelection/);
  assert.match(client, /\/magalu\/api\/catalog\/skus/);
  assert.match(client, /String\(row\.sku\) === sku/);
  assert.match(client, /\/magalu\/api\/writes\/preview/);
  assert.doesNotMatch(client, /portfolioWriteService/);
});
