"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateRealizedOrder,
  calculateV7Price,
  simulateV7SalePrice,
} = require("../src/services/PricingV7Engine");
const { DEFAULT_PRICING_SETTINGS } = require("../src/services/PricingV6Engine");

test("V7 reconcilia o pedido de referencia sem descontar taxas ja contidas no repasse", () => {
  const result = calculateRealizedOrder({
    orderSn: "260808T0XN90TQ",
    promotionalPriceCents: 119990,
    buyerShippingCents: 5990,
    sellerCouponCents: 4900,
    platformCouponCents: 8374,
    coinsCents: 48,
    gmvPaidCents: 112658,
    payoutCents: 101339,
    cmvCents: 66500,
    taxCents: 11999,
    commissionCents: 14367,
    rebateCents: 11422,
    adjustmentCents: -3474,
  });

  assert.equal(result.checkoutDeltaCents, 0);
  assert.equal(result.profitCents, 22840);
  assert.equal(result.marginRate, 22840 / 112658);
  assert.equal(result.taxBaseCents, 112658);
  assert.equal(result.taxEffectiveRate, 11999 / 112658);
});

test("V7 calcula imposto projetado sobre o valor total pago da NF", () => {
  const result = calculateV7Price({
    costCents: 5000,
    targetMarginRate: 0.2,
    settings: {
      ...DEFAULT_PRICING_SETTINGS,
      coupons: [],
      campaignEnabled: false,
      taxRate: 0.1,
      psychologicalEndings: [0],
      feeRules: [{ maxCents: null, commissionRate: 0.1, fixedFeeCents: 0 }],
      engineMode: "CALIBRATED",
    },
    calibration: {
      gmvFactor: 0.9,
      payoutGmvFactor: 0.9,
      alpha: 0.5,
      sampleSize: 20,
      effectiveSampleSize: 20,
      averageQuality: 0.9,
      stabilityScore: 0.9,
      scope: "SHOP",
    },
  });

  assert.equal(result.selected.mode, "CALIBRATED");
  assert.equal(
    result.calibrated.breakdown.taxCents,
    Math.round(result.calibrated.breakdown.gmvCents * 0.1),
  );
  assert.ok(result.calibrated.marginRate >= 0.2);
  assert.ok(result.safe.marginRate >= 0.2);
});

test("V7 aceita coorte de calibracao ausente e usa modo seguro", () => {
  const result = calculateV7Price({
    costCents: 5000,
    settings: {
      ...DEFAULT_PRICING_SETTINGS,
      coupons: [],
      campaignEnabled: false,
      psychologicalEndings: [0],
      engineMode: "HYBRID",
    },
    calibration: null,
  });

  assert.equal(result.selected.mode, "SAFE");
  assert.equal(result.calibration.sampleSize, 0);
  assert.ok(result.warnings.includes("FALLBACK_SEGURO"));
});

test("V7 usa o modo seguro quando a calibração não possui amostra confiável", () => {
  const result = calculateV7Price({
    costCents: 5000,
    settings: {
      ...DEFAULT_PRICING_SETTINGS,
      coupons: [],
      campaignEnabled: false,
      psychologicalEndings: [0],
      engineMode: "HYBRID",
    },
    calibration: { sampleSize: 1, effectiveSampleSize: 1, averageQuality: 0.4 },
  });

  assert.equal(result.selected.mode, "SAFE");
  assert.ok(result.warnings.includes("FALLBACK_SEGURO"));
});

test("V7 preserva as extremidades do hibrido", () => {
  const base = {
    costCents: 5000,
    settings: {
      ...DEFAULT_PRICING_SETTINGS,
      coupons: [],
      campaignEnabled: false,
      psychologicalEndings: [0],
      engineMode: "HYBRID",
      confidenceMode: "MANUAL",
    },
    calibration: {
      gmvFactor: 0.95,
      payoutGmvFactor: 0.9,
      sampleSize: 50,
      effectiveSampleSize: 50,
      averageQuality: 1,
      stabilityScore: 1,
      scope: "SHOP",
    },
  };
  const zero = calculateV7Price({ ...base, settings: { ...base.settings, manualAlpha: 0 } });
  const one = calculateV7Price({ ...base, settings: { ...base.settings, manualAlpha: 1 } });

  assert.equal(zero.hybrid.priceCents, zero.safe.priceCents);
  assert.equal(one.hybrid.priceCents, one.calibrated.priceCents);
});

test("simulador V7 mostra imposto sobre a base total projetada", () => {
  const result = simulateV7SalePrice({
    priceCents: 10000,
    costCents: 3000,
    settings: {
      ...DEFAULT_PRICING_SETTINGS,
      coupons: [],
      campaignEnabled: false,
      taxRate: 0.1,
      psychologicalEndings: [0],
      feeRules: [{ maxCents: null, commissionRate: 0.1, fixedFeeCents: 0 }],
      engineMode: "CALIBRATED",
    },
    calibration: {
      gmvFactor: 0.9,
      payoutGmvFactor: 0.9,
      sampleSize: 20,
      effectiveSampleSize: 20,
      averageQuality: 0.9,
      stabilityScore: 0.9,
    },
  });
  assert.equal(result.mode, "CALIBRATED");
  assert.equal(result.breakdown.taxCents, Math.round(result.breakdown.taxBaseCents * 0.1));
});
