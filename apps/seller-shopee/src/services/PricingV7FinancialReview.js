"use strict";

function cents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(Math.abs(number)) : 0;
}

function assessFinancialReview({
  gmvCents,
  payoutCents,
  itemsRevenueCents,
  buyerShippingCents,
  actualShippingCents,
  payoutReconciliationDeltaCents,
} = {}) {
  const gmv = cents(gmvCents);
  const payout = cents(payoutCents);
  const itemsRevenue = cents(itemsRevenueCents);
  const buyerShipping = cents(buyerShippingCents);
  const actualShipping = cents(actualShippingCents);
  const payoutDelta = Number(payoutReconciliationDeltaCents || 0);
  const reconciliationToleranceCents = Math.max(100, Math.round(gmv * 0.01));
  const highShippingThresholdCents = Math.max(
    5000,
    Math.round(Math.max(itemsRevenue, 1) * 0.2),
  );
  const highBuyerShipping = buyerShipping >= highShippingThresholdCents;
  const logisticsUnsettled = highBuyerShipping && actualShipping <= 0;
  const payoutUnreconciled = payout > 0 &&
    Math.abs(payoutDelta) > reconciliationToleranceCents;
  const reasons = [];

  if (logisticsUnsettled) reasons.push("frete_sem_contrapartida_logistica");
  if (payoutUnreconciled) reasons.push("repasse_nao_conciliado");

  return {
    requiresReview: reasons.length > 0,
    reasons,
    logisticsUnsettled,
    payoutUnreconciled,
    buyerShippingCents: buyerShipping,
    actualShippingCents: actualShipping,
    payoutReconciliationDeltaCents: payoutDelta,
    reconciliationToleranceCents,
  };
}

module.exports = { assessFinancialReview };
