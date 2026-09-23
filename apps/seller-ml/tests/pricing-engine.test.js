"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculatePricingSnapshot,
  calculateTargetPrice,
  decomposeMarketplaceFee,
  percentRate,
  solveTargetPrice,
} = require("../services/pricingEngine");

test("calcula lucro, margem e ROI com custos fixos e variaveis", () => {
  const result = calculatePricingSnapshot({
    price: 100,
    productCost: 40,
    commissionRate: 0.15,
    commissionFixed: 0,
    taxRate: 0.04,
    sellerShipping: 5,
    operationCost: 2,
    otherCosts: 1,
  });
  assert.equal(result.commission, 15);
  assert.equal(result.taxes, 4);
  assert.equal(result.total_costs, 67);
  assert.equal(result.profit, 33);
  assert.equal(result.margin_pct, 33);
  assert.equal(result.roi_pct, 82.5);
});

test("preco alvo usa a mesma equacao de custos fixos + taxas percentuais", () => {
  const price = calculateTargetPrice({
    fixedCosts: 50,
    commissionRate: 0.15,
    taxRate: 0.04,
    targetMargin: 0.15,
  });
  assert.equal(price, 75.76);
});

test("frete do comprador entra apenas na base fiscal", () => {
  const result = calculatePricingSnapshot({
    price: 100,
    productCost: 40,
    commissionRate: 0.1,
    taxRate: 0.05,
    buyerShippingTaxable: 20,
  });
  assert.equal(result.tax_base, 120);
  assert.equal(result.taxes, 6);
  assert.equal(result.total_costs, 56);
  assert.equal(result.profit, 44);
});

test("decompoe tarifa do ML entre percentual e fixa", () => {
  const fee = decomposeMarketplaceFee({
    price: 100,
    saleFee: 19,
    listingFee: 0,
    percentageFee: 15,
    fixedFee: 4,
  });
  assert.equal(fee.commission, 19);
  assert.equal(fee.commission_rate_pct, 15);
  assert.equal(fee.commission_fixed, 4);
});

test("percentRate converte percentual de interface em fracao", () => {
  assert.equal(percentRate(4), 0.04);
  assert.equal(percentRate(15), 0.15);
});

test("solver converge recalculando tarifa por faixa", async () => {
  const solved = await solveTargetPrice({
    targetMargin: 0.15,
    seedPrice: 80,
    quote: async (price) => {
      const fixedFee = price < 100 ? 4 : 0;
      return calculatePricingSnapshot({
        price,
        productCost: 50,
        commissionRate: 0.15,
        commissionFixed: fixedFee,
        taxRate: 0.04,
      });
    },
    maxIterations: 12,
  });
  assert.ok(solved.price > 70);
  assert.ok(solved.snapshot);
  assert.ok(Math.abs(Number(solved.snapshot.margin_pct) - 15) < 0.5);
});

