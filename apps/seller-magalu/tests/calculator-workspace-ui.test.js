"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("calculator offers synchronized SKU and manual simulation modes", () => {
  const html = read("views/app.html");
  const client = read("public/js/magalu-financial.js");

  assert.match(html, /data-calculator-mode="sku"/);
  assert.match(html, /data-calculator-mode="manual"/);
  assert.match(html, /id="mg-fin-sku-query"/);
  assert.match(html, /id="mg-fin-sku-results"/);
  assert.match(html, /id="mg-fin-selected-sku"/);
  assert.match(client, /catalog\/skus\?account_id=/);
  assert.match(client, /calculator\/lookup\?account_id=/);
  assert.doesNotMatch(client, /seller\/v1\//);
});

test("calculator keeps the result workspace sticky on desktop and linear on mobile", () => {
  const css = read("public/css/magalu-rich-workspaces.css");

  assert.match(css, /\.mg-calculator-layout\{[\s\S]*grid-template-columns/);
  assert.match(css, /\.mg-calculator-result\{[\s\S]*position:sticky/);
  assert.match(css, /@media\(max-width:1100px\)\{[\s\S]*\.mg-calculator-result\{position:static/);
});
