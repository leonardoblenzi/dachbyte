"use strict";

function number(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function money(value) { return Math.round((number(value) + Number.EPSILON) * 100) / 100; }
function percent(value) { return Math.max(0, number(value)); }

function calculatePricing(input = {}) {
  const salePrice = Math.max(0, number(input.sale_price));
  const hasUnitCost = input.unit_cost !== null && input.unit_cost !== undefined && input.unit_cost !== "" && Number.isFinite(Number(input.unit_cost));
  const unitCost = hasUnitCost ? Math.max(0, number(input.unit_cost)) : null;
  const rates = {
    commission: percent(input.commission_rate),
    platform_fee: percent(input.platform_fee_rate),
    tax: percent(input.tax_rate),
  };
  const totalRate = (rates.commission + rates.platform_fee + rates.tax) / 100;
  const variableCosts = money(salePrice * totalRate);
  const fixedCosts = money((unitCost || 0) + Math.max(0, number(input.commission_fixed)) + Math.max(0, number(input.platform_fee_fixed)) + Math.max(0, number(input.seller_shipping)) + Math.max(0, number(input.shipping_share)) + Math.max(0, number(input.seller_discount)) + Math.max(0, number(input.packaging_cost)) + Math.max(0, number(input.operational_cost)) + Math.max(0, number(input.other_cost)));
  const totalCosts = money(variableCosts + fixedCosts);
  const targetMargin = percent(input.target_margin) / 100;
  const breakEvenPrice = totalRate < 1 ? money(fixedCosts / (1 - totalRate)) : null;
  const targetPrice = totalRate + targetMargin < 1 ? money(fixedCosts / (1 - totalRate - targetMargin)) : null;
  if (!hasUnitCost) {
    return { estimate: true, cost_known: false, sale_price: money(salePrice), rates, variable_costs: variableCosts, fixed_costs: money(fixedCosts - (unitCost || 0)), total_costs: null, profit: null, margin_pct: null, roi_pct: null, break_even_price: null, target_price: null, target_price_reason: "UNIT_COST_REQUIRED" };
  }
  const profit = money(salePrice - totalCosts);
  return {
    estimate: true,
    cost_known: true,
    sale_price: money(salePrice),
    rates,
    variable_costs: variableCosts,
    fixed_costs: fixedCosts,
    total_costs: totalCosts,
    profit,
    margin_pct: salePrice > 0 ? money((profit / salePrice) * 100) : null,
    roi_pct: unitCost > 0 ? money((profit / unitCost) * 100) : null,
    break_even_price: breakEvenPrice,
    target_price: targetPrice,
    target_price_reason: targetPrice === null ? "TARGET_MARGIN_UNATTAINABLE" : null,
  };
}

module.exports = { calculatePricing };
