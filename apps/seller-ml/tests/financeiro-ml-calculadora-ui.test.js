"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "views", "financeiro-ml-calculadora.html"), "utf8");
const script = fs.readFileSync(path.join(root, "public", "js", "financeiro-ml-calculadora.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public", "css", "financeiro-ml-calculadora.css"), "utf8");

test("calculator keeps listing lookup and uses guided listing and freight controls", () => {
  assert.match(html, /id="calc-lookup-input"/);
  assert.match(html, /data-listing-type="gold_special"/);
  assert.match(html, /data-listing-type="gold_pro"/);
  assert.match(html, /data-shipping-mode="mercado_envios"/);
  assert.match(html, /data-shipping-mode="comprador"/);
  assert.match(html, /id="calc-seller-shipping-wrap"/);
  assert.match(html, /id="calc-buyer-shipping-wrap"/);
});

test("loaded listing shows its shipping mode and estimated seller cost separately from payment", () => {
  assert.match(html, /id="calc-listing-shipping-context"[^>]*hidden/);
  assert.match(html, /id="calc-listing-shipping-mode"/);
  assert.match(html, /id="calc-listing-shipping-payment"/);
  assert.match(html, /id="calc-listing-shipping-quote"/);
  assert.match(script, /rules\.listingShippingContext\(row\)/);
  assert.match(script, /syncShippingMode\(shippingContext\.simulationMode\)/);
  assert.match(script, /Custo estimado do vendedor pelo ML/);
  assert.match(css, /\.calc-listing-shipping-context\[hidden\]/);
});

test("buyer-paid ME2 exposes seller and buyer shipping fields together", () => {
  assert.match(html, /id="calc-split-shipping-alert"[^>]*role="alert"/);
  assert.match(script, /isSplitShipping\(\)/);
  assert.match(script, /Estimativa do ML/);
  assert.match(css, /\.calc-segmented-control\[hidden\]/);
});

test("incomplete ME2 shipping blocks stale profit display", () => {
  assert.match(html, /id="calc-confirm-shipping"/);
  assert.match(script, /rules\.splitShippingReadiness/);
  assert.match(script, /calculationScheduler\.cancel\(\)/);
  assert.match(script, /Frete pendente/);
  assert.match(script, /\["calc-breakdown-price",[^\n]+\]\.forEach\(\(id\) => setText\(id, "--"\)\)/);
});

test("switching away from a split listing restores exclusive manual freight controls", () => {
  assert.match(script, /function setMode\(mode\)[\s\S]*?syncListingTypeControl\(\);\s*syncShippingMode\(\);\s*scheduleCalculation\(\);/);
});

test("calculator shows the origin and confidence of its inputs", () => {
  assert.match(html, /id="calc-cost-confidence"/);
  assert.match(html, /id="calc-loaded-category"/);
  assert.match(html, /id="calc-breakdown-cost-source"/);
  assert.match(html, /id="calc-breakdown-commission-source"/);
  assert.match(html, /id="calc-breakdown-shipping-source"/);
  assert.match(css, /\.calc-shipping-field\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test("calculator sends only the freight relevant to the selected mode", () => {
  assert.match(script, /rules\.normalizeShippingInputs\(state\.shippingMode/);
  assert.match(script, /seller_shipping: shipping\.sellerShipping/);
  assert.match(script, /buyer_shipping_taxable: shipping\.buyerShipping/);
});

test("calculator removes the redundant result heading and inherits Margin tokens", () => {
  assert.match(html, /<h2>Lucro por unidade<\/h2>/);
  assert.doesNotMatch(html, /<span class="calc-eyebrow">Resultado<\/span>\s*<h2>Resultado da simulação<\/h2>/);
  assert.match(html, /class="calc-shell container"/);
  assert.match(html, /financeiro-ml\.css/);
  assert.match(css, /var\(--fml-blue/);
  assert.match(css, /var\(--fml-yellow/);
  assert.doesNotMatch(css, /#0f766e/);
});

test("manual calculator selects a category suggestion before requesting ML fees", () => {
  assert.match(html, /id="calc-category-query"/);
  assert.match(html, /id="calc-category-id"[^>]*type="hidden"/);
  assert.match(html, /id="calc-category-suggestions"[^>]*role="listbox"/);
  assert.doesNotMatch(html, /id="calc-use-ml-fee"/);
  assert.match(script, /calculator\/categories/);
  assert.match(script, /canQuoteMarketplaceFee/);
});
