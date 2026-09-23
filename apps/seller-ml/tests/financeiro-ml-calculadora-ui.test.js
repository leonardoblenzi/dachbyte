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

test("calculator sends only the freight relevant to the selected mode", () => {
  assert.match(script, /shippingMode === "mercado_envios" \? inputValue\("calc-seller-shipping"\) : 0/);
  assert.match(script, /shippingMode === "comprador" \? inputValue\("calc-buyer-shipping"\) : 0/);
});

test("calculator removes the redundant result heading and retains DACH ML tokens", () => {
  assert.match(html, /<h2>Lucro por unidade<\/h2>/);
  assert.doesNotMatch(html, /<span class="calc-eyebrow">Resultado<\/span>\s*<h2>Resultado da simulação<\/h2>/);
  assert.match(css, /#ff9a4d/);
  assert.match(css, /#0f766e/);
});
