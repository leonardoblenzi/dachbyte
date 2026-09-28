"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { calculatePricing } = require("../src/services/magaluPricingEngine");

test("calculates Magalu contribution margin from explicit commercial charges", () => {
  const result = calculatePricing({
    sale_price: 200,
    unit_cost: 80,
    commission_rate: 12,
    commission_fixed: 2,
    platform_fee_rate: 1,
    seller_shipping: 10,
    shipping_share: 4,
    seller_discount: 5,
    tax_rate: 6,
    packaging_cost: 3,
    operational_cost: 2,
    other_cost: 1,
    target_margin: 20,
  });
  assert.equal(result.variable_costs, 38);
  assert.equal(result.fixed_costs, 107);
  assert.equal(result.total_costs, 145);
  assert.equal(result.profit, 55);
  assert.equal(result.margin_pct, 27.5);
  assert.equal(result.roi_pct, 68.75);
  assert.equal(result.break_even_price, 132.1);
  assert.equal(result.target_price, 175.41);
  assert.equal(result.estimate, true);
});

test("does not fabricate a target price when charges plus target consume revenue", () => {
  const result = calculatePricing({ sale_price: 100, unit_cost: 50, commission_rate: 60, tax_rate: 30, target_margin: 20 });
  assert.equal(result.target_price, null);
  assert.equal(result.target_price_reason, "TARGET_MARGIN_UNATTAINABLE");
});

test("treats missing SKU cost as unknown instead of zero", () => {
  const result = calculatePricing({ sale_price: 100, unit_cost: null, commission_rate: 10 });
  assert.equal(result.cost_known, false);
  assert.equal(result.profit, null);
  assert.equal(result.margin_pct, null);
});
