"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { quantityForListing, kitAvailable, effectiveRule } = require("../src/modules/stock/rules");

test("regra padrão envia o disponível; Full nunca recebe escrita", () => {
  assert.equal(quantityForListing({ available: 12 }), 12);
  assert.equal(quantityForListing({ available: 12, fulfillment: true }), null);
  assert.equal(quantityForListing({ available: -3 }), 0);
});

test("fixo, percentual, reserva, trava mínima e teto", () => {
  assert.equal(quantityForListing({ available: 50, rule: { mode: "fixed", value: 5 } }), 5);
  assert.equal(quantityForListing({ available: 50, rule: { mode: "percent", value: 30 } }), 15);
  assert.equal(quantityForListing({ available: 50, rule: { safetyReserve: 2 } }), 48);
  assert.equal(quantityForListing({ available: 3, rule: { minLock: 3 } }), 0, "no limite da trava zera o anúncio");
  assert.equal(quantityForListing({ available: 4, rule: { minLock: 3 } }), 4);
  assert.equal(quantityForListing({ available: 500, rule: { cap: 100 } }), 100);
  assert.equal(quantityForListing({ available: 1, rule: { safetyReserve: 5 } }), 0);
});

test("kit usa o menor componente", () => {
  assert.equal(kitAvailable([{ available: 10, quantity: 4 }, { available: 7, quantity: 1 }]), 2);
  assert.equal(kitAvailable([{ available: 10, quantity: 0 }]), 0);
  assert.equal(kitAvailable([]), 0);
});

test("regra do anúncio vence a da conta", () => {
  assert.deepEqual(effectiveRule({ mode: "percent", value: 50, cap: 20 }, { cap: 10 }).cap, 10);
  assert.equal(effectiveRule(null, null).mode, "same");
});
