"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("calculator payload forwards selected listing logistics and candidate labels stay DOM-safe", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "js", "financeiro-ml-calculadora.js"), "utf8");
  assert.match(source, /shipping_mode:\s*state\.selected\?\.shipping_mode/);
  assert.match(source, /logistic_type:\s*state\.selected\?\.logistic_type/);
  assert.match(source, /shipping_dimensions:\s*state\.selected\?\.shipping_dimensions/);
  assert.match(source, /shipping_weight:\s*state\.selected\?\.shipping_weight/);
  assert.doesNotMatch(source, /select\.innerHTML\s*=/);
  assert.match(source, /option\.textContent\s*=\s*label/);
});

test("manual calculator sends an ML quote only from a selected category and price", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "js", "financeiro-ml-calculadora.js"), "utf8");
  assert.match(source, /calc-category-id/);
  assert.match(source, /rules\.canQuoteMarketplaceFee/);
  assert.match(source, /use_ml_fee:\s*autoFee/);
  assert.match(source, /option\.textContent\s*=\s*row\.domain_name/);
});
