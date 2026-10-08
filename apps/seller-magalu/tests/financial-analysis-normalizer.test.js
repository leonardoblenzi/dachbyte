"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeReport } = require("../src/services/financialAnalysisNormalizer");

function tx(type, category, value, subcategory = "") {
  return { type, category, subcategory, value, normalizer: 100, currency: "BRL" };
}

test("reconciles credits and debits without counting informative tax or absolute discount twice", () => {
  const result = normalizeReport({
    external_id: "order-1",
    transactions: [
      tx("CREDIT", "SALE", 10000, "PRODUCT"),
      tx("DEBIT", "COMMISSION", 1200, "SERVICE"),
      tx("DEBIT", "FEES", 300, "PLATFORM"),
      tx("DEBIT", "SHIPPING_COST", 500, "FREIGHT"),
      tx("DEBIT", "PROMOTION", 200, "COUPON"),
      tx("CREDIT", "PROMOTION", 50, "COUPON"),
      tx("CREDIT", "MARKETPLACE", 100, "SHIPPING_SUBSIDY"),
      tx("DEBIT", "PROMOTION", 1000, "ABSOLUTE_DISCOUNT"),
      tx("INFORMATIVE", "TAXES", 1000, "ICMS"),
    ],
  });
  assert.equal(result.orderCode, "order-1");
  assert.equal(result.netReceivable, 79.5);
  assert.equal(result.sale, 100);
  assert.equal(result.commission, 12);
  assert.equal(result.fees, 3);
  assert.equal(result.shippingNet, -5);
  assert.equal(result.promotionNet, -2);
  assert.equal(result.subsidy, 1.5);
  assert.equal(result.ignoredAbsoluteDiscount, 10);
});

test("normalizer rejects invalid money instead of presenting a false zero", () => {
  assert.throws(() => normalizeReport({ external_id: "x", transactions: [tx("CREDIT", "SALE", 100, "PRODUCT"), { type: "DEBIT", category: "FEES", value: 50, normalizer: 0 }] }), /normalizer/i);
});

test("normalizer requires an order identity and transactions", () => {
  assert.throws(() => normalizeReport({ transactions: [] }), /pedido/i);
  assert.throws(() => normalizeReport({ external_id: "x" }), /transaç/i);
});
