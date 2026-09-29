"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Magalu pricing has filterable costs and margin plus a guided calculator", () => {
  const html = read("views/app.html");
  const client = read("public/js/magalu-financial.js");
  assert.match(html, /id="mg-financial-cost-search"/);
  assert.match(html, /id="mg-financial-margin-search"/);
  assert.match(html, /data-calculator-step="sale"/);
  assert.match(html, /data-calculator-step="fees"/);
  assert.match(html, /data-calculator-step="result"/);
  assert.match(html, /Financial Analysis/);
  assert.match(client, /mg-financial-cost-search/);
  assert.match(client, /mg-financial-margin-search/);
  assert.doesNotMatch(client, /seller\/v1/);
});
