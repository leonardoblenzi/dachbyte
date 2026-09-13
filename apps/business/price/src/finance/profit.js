"use strict";

const { amount } = require("./fees");

const MANUAL_COMPONENTS = [
  ["seller_discount", "sellerDiscountAmount"],
  ["marketplace_discount", "marketplaceDiscountAmount"],
  ["coins", "coinsAmount"],
  ["affiliate", "affiliateAmount"],
  ["shipping", "shippingAmount"],
  ["ads", "adsAmount"],
  ["tax", "taxAmount"],
  ["cost", "costAmount"],
  ["packaging", "packagingAmount"],
  ["other", "otherAmount"],
];

function manualComponents(input = {}) {
  return MANUAL_COMPONENTS.map(([type, key]) => ({
    type,
    amount: amount(input[key]),
    sourceType: type === "cost" && input.costSource === "ERP" ? "ERP" : "MANUAL",
    sourceRef: key,
  })).filter((item) => item.amount !== 0);
}

function calculateProfit({ grossAmount, feeComponents = [], expectedFeeAmount = null, input = {}, extraComponents = [] }) {
  const gross = amount(grossAmount);
  const manual = manualComponents(input);
  const actualFees = amount(feeComponents.reduce((sum, item) => sum + amount(item.amount), 0));
  const expectedFees = expectedFeeAmount === null || expectedFeeAmount === undefined ? actualFees : amount(expectedFeeAmount);
  const externalCosts = amount(extraComponents.reduce((sum, item) => sum + amount(item.amount), 0));
  const manualCosts = amount(manual.reduce((sum, item) => sum + item.amount, 0) + externalCosts);
  const expectedContribution = amount(gross - expectedFees - manualCosts);
  const hasRealizedFees = feeComponents.length > 0;
  const realizedContribution = hasRealizedFees ? amount(gross - actualFees - manualCosts) : null;
  const calculationType = hasRealizedFees ? "realized" : "expected";
  const components = [
    ...feeComponents.map((item) => ({ ...item, sourceType: item.sourceType || "API" })),
    ...extraComponents,
    ...manual,
  ];
  return {
    grossAmount: gross,
    feesAmount: hasRealizedFees ? actualFees : expectedFees,
    expectedFeesAmount: expectedFees,
    manualCosts,
    expectedContribution,
    realizedContribution,
    contributionAmount: realizedContribution ?? expectedContribution,
    calculationType,
    components,
  };
}

function extractOrderItems(raw = {}) {
  const candidates = raw.ProductsSold || raw.products || raw.items || raw.OrderProducts || [];
  const list = Array.isArray(candidates) ? candidates : [candidates];
  return list.map((wrapper) => wrapper?.ProductSold || wrapper?.Product || wrapper?.Item || wrapper)
    .filter(Boolean)
    .map((item) => ({
      sku: String(item.sku || item.reference || item.product_id || item.id || "").trim() || null,
      title: String(item.name || item.title || item.product_name || "").trim() || null,
      quantity: amount(item.quantity || item.amount || 1) || 1,
      unitPrice: amount(item.price || item.unit_price || item.original_price || 0),
    }));
}

function allocateItems(items, result) {
  if (!items.length) return [];
  const grossValues = items.map((item) => amount(item.quantity * item.unitPrice));
  const grossTotal = grossValues.reduce((sum, value) => sum + value, 0);
  return items.map((item, index) => {
    const ratio = grossTotal > 0 ? grossValues[index] / grossTotal : 1 / items.length;
    const allocatedCosts = amount((result.grossAmount - result.contributionAmount) * ratio);
    return { ...item, grossAmount: grossValues[index], allocationRatio: ratio, costAmount: allocatedCosts, contributionAmount: amount(grossValues[index] - allocatedCosts) };
  });
}

module.exports = { calculateProfit, manualComponents, extractOrderItems, allocateItems };
