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

test("calculator connects exclusive freight and confidence labels to the result", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "js", "financeiro-ml-calculadora.js"), "utf8");
  assert.match(source, /rules\.normalizeShippingInputs/);
  assert.match(source, /\$\("calc-seller-shipping"\)\.disabled = !visible\.seller/);
  assert.match(source, /\$\("calc-buyer-shipping"\)\.disabled = !visible\.buyer/);
  assert.match(source, /setText\("calc-loaded-category"/);
  assert.match(source, /setText\("calc-breakdown-cost-source"/);
  assert.match(source, /Sem tarifa fixa aplicável/);
  assert.match(source, /calc-cost-confidence/);
});

test("buyer-paid ME2 payload preserves both seller and buyer shipping shares", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "js", "financeiro-ml-calculadora.js"), "utf8");
  assert.match(source, /split:\s*isSplitShipping\(\)/);
  assert.match(source, /seller_shipping:\s*shipping\.sellerShipping/);
  assert.match(source, /buyer_shipping_taxable:\s*shipping\.buyerShipping/);
});
