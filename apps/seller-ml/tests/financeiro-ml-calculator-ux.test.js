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

test("shipping inputs keep only the active mode's amount", () => {
  assert.deepEqual(rules.normalizeShippingInputs("mercado_envios", { sellerShipping: 18, buyerShipping: 42 }), {
    sellerShipping: 18, buyerShipping: 0,
  });
  assert.deepEqual(rules.normalizeShippingInputs("comprador", { sellerShipping: 18, buyerShipping: 42 }), {
    sellerShipping: 0, buyerShipping: 42,
  });
});

test("buyer-paid ME2 keeps both shipping shares", () => {
  const context = rules.listingShippingContext({
    shipping_mode: "me2", free_shipping: false,
    shipping_source: "users_shipping_options_free", seller_shipping: 8.4,
  });
  assert.equal(context.split, true);
  assert.equal(context.quoteStatus, "estimated");
  assert.deepEqual(rules.shippingVisibility("comprador", { split: true }), { seller: true, buyer: true });
  assert.deepEqual(rules.normalizeShippingInputs("comprador", {
    sellerShipping: 8.4, buyerShipping: 5,
  }, { split: true }), { sellerShipping: 8.4, buyerShipping: 5 });
});

test("split-shipping result waits for a known seller share at this price", () => {
  const base = { split: true, source: "users_shipping_options_free",
    loadedPrice: 35.9, currentPrice: 35.9, quotedValue: 8.4,
    sellerValue: "8.4", manuallyConfirmedPrice: null };
  assert.deepEqual(rules.splitShippingReadiness(base), { ready: true, reason: "" });
  assert.deepEqual(rules.splitShippingReadiness({ ...base, source: "unavailable", sellerValue: "" }),
    { ready: false, reason: "missing" });
  assert.deepEqual(rules.splitShippingReadiness({ ...base, currentPrice: 40 }),
    { ready: false, reason: "stale" });
  assert.deepEqual(rules.splitShippingReadiness({ ...base, source: "unavailable", sellerValue: "0", manuallyConfirmedPrice: 35.9 }),
    { ready: true, reason: "" });
  assert.deepEqual(rules.splitShippingReadiness({ ...base, split: false }), { ready: true, reason: "" });
});

test("listing shipping context separates ME2 logistics from who pays", () => {
  assert.deepEqual(rules.listingShippingContext({
    shipping_mode: "me2",
    logistic_type: "cross_docking",
    free_shipping: true,
    shipping_source: "users_shipping_options_free",
  }), {
    modeLabel: "Mercado Envios 2 (ME2)",
    logisticLabel: "Coleta",
    paymentLabel: "Frete grátis para o comprador",
    simulationMode: "mercado_envios",
    quoteStatus: "estimated",
  });
  assert.equal(rules.listingShippingContext({ shipping_mode: "me2", free_shipping: false }).simulationMode, "comprador");
});

test("ME1 and agreed delivery default to optional buyer-paid freight", () => {
  for (const shipping_mode of ["me1", "not_specified", "to_be_agreed"]) {
    const context = rules.listingShippingContext({ shipping_mode, free_shipping: true });
    assert.equal(context.simulationMode, "comprador");
    assert.equal(context.quoteStatus, "not_applicable");
  }
  assert.equal(rules.listingShippingContext({ shipping_mode: "not_specified" }).modeLabel, "Entrega a combinar");
});

test("listing shipping context does not invent a missing seller quote", () => {
  const context = rules.listingShippingContext({
    shipping_mode: "me2", free_shipping: true, shipping_source: "unavailable", seller_shipping: 0,
  });
  assert.equal(context.quoteStatus, "unavailable");
  assert.equal(rules.listingShippingContext({ shipping_mode: "unexpected" }).modeLabel, "Modo não informado");
});

test("a missing product cost makes ROI unavailable", () => {
  assert.deepEqual(rules.costConfidence(0), { state: "missing", roiAvailable: false });
  assert.deepEqual(rules.costConfidence(27.5), { state: "ready", roiAvailable: true });
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
