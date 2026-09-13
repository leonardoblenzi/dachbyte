"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { assessFinancialReview } = require("../src/services/PricingV7FinancialReview");

test("marca frete alto sem custo e repasse pendente para revisao", () => {
  const review = assessFinancialReview({ gmvCents: 315798, payoutCents: 296851, itemsRevenueCents: 168244, buyerShippingCents: 168754, actualShippingCents: 0, payoutReconciliationDeltaCents: 5720 });
  assert.equal(review.requiresReview, true);
  assert.deepEqual(review.reasons, ["frete_sem_contrapartida_logistica", "repasse_nao_conciliado"]);
});
