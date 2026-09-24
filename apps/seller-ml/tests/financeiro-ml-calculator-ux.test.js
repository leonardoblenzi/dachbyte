"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rules = require("../public/js/financeiro-ml-calculator-rules.js");

test("manual listing type supplies its preset fee and leaves fixed fee optional", () => {
  assert.deepEqual(rules.manualListingFee("gold_special"), {
    commissionRatePct: 11.5,
    commissionFixed: 0,
  });
  assert.deepEqual(rules.manualListingFee("gold_pro"), {
    commissionRatePct: 16.5,
    commissionFixed: 0,
  });
});

test("manual fee quote needs price, category and a supported listing type", () => {
  assert.equal(rules.canQuoteMarketplaceFee({
    price: 100, categoryId: "MLB1055", listingTypeId: "gold_pro",
  }), true);
  assert.equal(rules.canQuoteMarketplaceFee({
    price: 0, categoryId: "MLB1055", listingTypeId: "gold_pro",
  }), false);
  assert.deepEqual(rules.manualFeeMode({ price: 100, categoryId: "" }), {
    source: "estimativa", quote: false,
  });
  assert.deepEqual(rules.manualFeeMode({
    price: 100, categoryId: "MLB1055", listingTypeId: "gold_special",
  }), { source: "consultando", quote: true });
});

test("shipping mode reveals exactly one relevant monetary field", () => {
  assert.deepEqual(rules.shippingVisibility("mercado_envios"), { seller: true, buyer: false });
  assert.deepEqual(rules.shippingVisibility("comprador"), { seller: false, buyer: true });
});

test("calculation scheduler consolidates rapid field changes", async () => {
  const calls = [];
  const scheduler = rules.createCalculationScheduler(() => calls.push("calculate"), 15);
  scheduler.schedule();
  scheduler.schedule();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(calls, ["calculate"]);
});

test("calculator keeps only Clear and binds automatic calculation", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "views", "financeiro-ml-calculadora.html"), "utf8");
  const source = fs.readFileSync(path.join(root, "public", "js", "financeiro-ml-calculadora.js"), "utf8");
  assert.doesNotMatch(html, /id="calc-submit"/);
  assert.match(html, /id="calc-reset"/);
  assert.match(source, /scheduleCalculation\(\)/);
  assert.match(source, /createCalculationScheduler/);
});
