"use strict";

const DEFAULT_PRICING_SETTINGS = Object.freeze({
  targetMarginRate: 0.2,
  campaignEnabled: false,
  campaignRate: 0.035,
  variableCostRate: 0,
  taxRate: 0,
  fullPriceMarkup: 0,
  fullPriceAdditionCents: 0,
  psychologicalEndings: [90, 99, 49],
  feeRules: [
    { maxCents: 799, commissionRate: 0.5, fixedFeeCents: 0 },
    { maxCents: 7999, commissionRate: 0.2, fixedFeeCents: 400 },
    { maxCents: 9999, commissionRate: 0.14, fixedFeeCents: 1600 },
    { maxCents: 19999, commissionRate: 0.14, fixedFeeCents: 2000 },
    { maxCents: null, commissionRate: 0.14, fixedFeeCents: 2600 },
  ],
  coupons: [
    { id: "coupon_2_50", label: "2% acima de R$ 50", percent: 2, minimumCents: 5000, capCents: 1000, active: true },
    { id: "coupon_3_499_90", label: "3% acima de R$ 499,90", percent: 3, minimumCents: 49990, capCents: 2100, active: true },
    { id: "coupon_7_699", label: "7% acima de R$ 699", percent: 7, minimumCents: 69900, capCents: 4900, active: true },
  ],
  pixDiscountRules: [
    { minCents: 8000, maxCents: 49999, rate: 0.05 },
    { minCents: 50000, maxCents: null, rate: 0.08 },
  ],
});

const FEE_RULES = Object.freeze([
  { maxCents: 799, commissionRate: 0.5, fixedFeeCents: 0 },
  { maxCents: 7999, commissionRate: 0.2, fixedFeeCents: 400 },
  { maxCents: 9999, commissionRate: 0.14, fixedFeeCents: 1600 },
  { maxCents: 19999, commissionRate: 0.14, fixedFeeCents: 2000 },
  { maxCents: Number.POSITIVE_INFINITY, commissionRate: 0.14, fixedFeeCents: 2600 },
]);

function clampNumber(value, fallback, min = 0, max = Number.POSITIVE_INFINITY) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function toCents(value, fallback = 0) {
  return Math.round(clampNumber(value, fallback, 0));
}

function normalizeRate(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const rate = numeric > 1 ? numeric / 100 : numeric;
  return Math.min(1, Math.max(0, rate));
}

function normalizeEndings(endings) {
  const entries = Array.from(new Set((Array.isArray(endings) ? endings : [])
    .map((entry) => Math.trunc(Number(entry)))
    .filter((entry) => entry >= 0 && entry <= 99)));
  return entries.length ? entries.sort((a, b) => a - b) : [90, 99, 49];
}

function normalizeCouponRule(coupon, index) {
  return {
    id: String(coupon?.id || `coupon_${index + 1}`),
    label: String(coupon?.label || `Cupom ${index + 1}`),
    percent: clampNumber(coupon?.percent, 0, 0, 100),
    minimumCents: toCents(coupon?.minimumCents, 0),
    capCents: toCents(coupon?.capCents, 0),
    active: coupon?.active !== false,
  };
}

function normalizeFeeRules(rules) {
  const defaults = DEFAULT_PRICING_SETTINGS.feeRules;
  const normalized = (Array.isArray(rules) ? rules : defaults)
    .map((rule, index) => ({
      maxCents: rule?.maxCents == null || !Number.isFinite(Number(rule?.maxCents))
        ? null
        : toCents(rule.maxCents, defaults[index]?.maxCents || 0),
      commissionRate: normalizeRate(rule?.commissionRate, defaults[index]?.commissionRate || 0),
      fixedFeeCents: toCents(rule?.fixedFeeCents, defaults[index]?.fixedFeeCents || 0),
    }))
    .filter((rule) => rule.maxCents == null || rule.maxCents > 0)
    .sort((left, right) => (left.maxCents == null ? Number.POSITIVE_INFINITY : left.maxCents) - (right.maxCents == null ? Number.POSITIVE_INFINITY : right.maxCents));
  return normalized.length ? normalized : DEFAULT_PRICING_SETTINGS.feeRules;
}

function normalizeSettings(settings = {}) {
  const merged = { ...DEFAULT_PRICING_SETTINGS, ...(settings || {}) };
  return {
    targetMarginRate: normalizeRate(merged.targetMarginRate, DEFAULT_PRICING_SETTINGS.targetMarginRate),
    campaignEnabled: Boolean(merged.campaignEnabled),
    campaignRate: normalizeRate(merged.campaignRate, DEFAULT_PRICING_SETTINGS.campaignRate),
    variableCostRate: normalizeRate(merged.variableCostRate, DEFAULT_PRICING_SETTINGS.variableCostRate),
    taxRate: normalizeRate(merged.taxRate, DEFAULT_PRICING_SETTINGS.taxRate),
    fullPriceMarkup: clampNumber(merged.fullPriceMarkup, DEFAULT_PRICING_SETTINGS.fullPriceMarkup, 0),
    fullPriceAdditionCents: toCents(merged.fullPriceAdditionCents, DEFAULT_PRICING_SETTINGS.fullPriceAdditionCents),
    psychologicalEndings: normalizeEndings(merged.psychologicalEndings),
    feeRules: normalizeFeeRules(merged.feeRules),
    coupons: (Array.isArray(merged.coupons) ? merged.coupons : [])
      .map(normalizeCouponRule)
      .filter((coupon) => coupon.active && coupon.percent > 0),
    pixDiscountRules: (Array.isArray(merged.pixDiscountRules) ? merged.pixDiscountRules : [])
      .map((rule) => ({
        minCents: toCents(rule?.minCents, 0),
        maxCents: rule?.maxCents == null ? null : toCents(rule.maxCents, 0),
        rate: normalizeRate(rule?.rate, 0),
      }))
      .filter((rule) => rule.rate > 0)
      .sort((left, right) => left.minCents - right.minCents),
  };
}

function getFeeRule(priceCents, feeRules = FEE_RULES) {
  const price = toCents(priceCents, 0);
  const rules = normalizeFeeRules(feeRules);
  const rule = rules.find((entry) => entry.maxCents == null || price <= entry.maxCents) || rules[rules.length - 1];
  return { commissionRate: rule.commissionRate, fixedFeeCents: rule.fixedFeeCents };
}

function getEligibleCouponDiscount(priceCents, coupons = []) {
  const price = toCents(priceCents, 0);
  const candidates = (Array.isArray(coupons) ? coupons : [])
    .map(normalizeCouponRule)
    .filter((coupon) => coupon.active && coupon.percent > 0 && price >= coupon.minimumCents)
    .map((coupon) => ({
      ...coupon,
      discountCents: Math.min(coupon.capCents, Math.round((price * coupon.percent) / 100)),
    }))
    .filter((coupon) => coupon.discountCents > 0);

  if (!candidates.length) {
    return { discountCents: 0, coupon: null };
  }

  const selected = candidates.sort((left, right) => right.discountCents - left.discountCents)[0];
  return { discountCents: selected.discountCents, coupon: selected };
}

function getPixDiscountRate(priceCents, pixDiscountRules = []) {
  const price = toCents(priceCents, 0);
  const rule = (Array.isArray(pixDiscountRules) ? pixDiscountRules : []).find((entry) =>
    price >= entry.minCents && (entry.maxCents == null || price <= entry.maxCents),
  );
  return rule ? normalizeRate(rule.rate, 0) : 0;
}

function roundUpToPsychologicalPrice(priceCents, endings = [90, 99, 49]) {
  const price = toCents(priceCents, 0);
  const normalizedEndings = normalizeEndings(endings);
  const base = Math.floor(price / 100) * 100;
  for (let offset = 0; offset <= 100; offset += 100) {
    for (const ending of normalizedEndings) {
      const candidate = base + offset + ending;
      if (candidate >= price) return candidate;
    }
  }
  return base + 199;
}

function buildBreakdown({ priceCents, costCents, logisticsCostCents, otherFixedCostCents, settings }) {
  const price = toCents(priceCents, 0);
  const normalizedSettings = normalizeSettings(settings);
  const costsCents = toCents(costCents) + toCents(logisticsCostCents) + toCents(otherFixedCostCents);
  const coupon = getEligibleCouponDiscount(price, normalizedSettings.coupons);
  const revenueAfterCouponCents = Math.max(0, price - coupon.discountCents);
  const feeRule = getFeeRule(price, normalizedSettings.feeRules);
  const commissionCents = Math.round(revenueAfterCouponCents * feeRule.commissionRate);
  const campaignCents = normalizedSettings.campaignEnabled
    ? Math.round(revenueAfterCouponCents * normalizedSettings.campaignRate)
    : 0;
  const variableCostCents = Math.round(revenueAfterCouponCents * normalizedSettings.variableCostRate);
  const taxCents = Math.round(revenueAfterCouponCents * normalizedSettings.taxRate);
  const totalFeesCents = commissionCents + feeRule.fixedFeeCents + campaignCents + variableCostCents + taxCents;
  const contributionCents = revenueAfterCouponCents - totalFeesCents - costsCents;
  const marginRate = revenueAfterCouponCents > 0 ? contributionCents / revenueAfterCouponCents : -1;
  const pixDiscountRate = getPixDiscountRate(price, normalizedSettings.pixDiscountRules);
  const pixPriceCents = Math.max(0, price - Math.round(price * pixDiscountRate));

  return {
    priceCents: price,
    costsCents,
    couponDiscountCents: coupon.discountCents,
    coupon: coupon.coupon,
    revenueAfterCouponCents,
    commissionCents,
    fixedFeeCents: feeRule.fixedFeeCents,
    campaignCents,
    variableCostCents,
    taxCents,
    totalFeesCents,
    contributionCents,
    marginRate,
    pixDiscountRate,
    pixPriceCents,
    feeRule,
  };
}

function solveCandidates({ costsCents, targetMarginRate, settings }) {
  const normalizedSettings = normalizeSettings(settings);
  const feeRules = normalizedSettings.feeRules;
  const candidates = new Set([1]);
  const coupons = normalizedSettings.coupons;
  let previousMaxCents = 0;
  for (const fee of feeRules) {
    if (fee.maxCents != null) {
      candidates.add(fee.maxCents);
      candidates.add(fee.maxCents + 1);
      previousMaxCents = fee.maxCents;
    } else {
      candidates.add(previousMaxCents + 1);
    }
  }

  coupons.forEach((coupon) => {
    candidates.add(coupon.minimumCents);
    if (coupon.percent > 0 && coupon.capCents > 0) {
      candidates.add(Math.ceil((coupon.capCents * 100) / coupon.percent));
    }
  });

  for (const fee of feeRules) {
    const rateAfterFees = 1
      - fee.commissionRate
      - normalizedSettings.variableCostRate
      - normalizedSettings.taxRate
      - (normalizedSettings.campaignEnabled ? normalizedSettings.campaignRate : 0)
      - targetMarginRate;
    if (rateAfterFees <= 0) continue;

    const requiredRevenue = Math.ceil(
      (costsCents + fee.fixedFeeCents) / rateAfterFees,
    );
    candidates.add(requiredRevenue);
    for (const coupon of coupons) {
      const proportionalPrice = Math.ceil(requiredRevenue / Math.max(0.01, 1 - coupon.percent / 100));
      candidates.add(Math.max(coupon.minimumCents, proportionalPrice));
      candidates.add(Math.max(coupon.minimumCents, requiredRevenue + coupon.capCents));
    }
  }

  return Array.from(candidates).filter((candidate) => Number.isFinite(candidate) && candidate > 0);
}

function calculatePrice(input = {}) {
  const settings = normalizeSettings(input.settings);
  const costCents = toCents(input.costCents, 0);
  const logisticsCostCents = toCents(input.logisticsCostCents, 0);
  const otherFixedCostCents = toCents(input.otherFixedCostCents, 0);
  const targetMarginRate = normalizeRate(input.targetMarginRate, settings.targetMarginRate);
  const fullPriceCents = Math.max(0, Math.round(costCents * settings.fullPriceMarkup) + settings.fullPriceAdditionCents);
  const evaluated = new Map();

  solveCandidates({
    costsCents: costCents + logisticsCostCents + otherFixedCostCents,
    targetMarginRate,
    settings,
  }).forEach((candidate) => {
    for (let index = 0; index < 4; index += 1) {
      const priceCents = roundUpToPsychologicalPrice(candidate + index * 100, settings.psychologicalEndings);
      if (evaluated.has(priceCents)) continue;
      evaluated.set(priceCents, buildBreakdown({ priceCents, costCents, logisticsCostCents, otherFixedCostCents, settings }));
    }
  });

  const healthy = Array.from(evaluated.values())
    .filter((row) => row.marginRate + 0.000001 >= targetMarginRate)
    .sort((left, right) => left.priceCents - right.priceCents);
  const chosen = healthy[0] || null;

  if (!chosen) {
    return {
      status: "unpriceable",
      reason: "Nenhum preco configurado preserva a margem alvo.",
      targetMarginRate,
      fullPriceCents,
      recommendedPriceCents: null,
      secondBestPriceCents: null,
      pixPriceCents: null,
      promotionPercent: null,
      breakdown: null,
    };
  }

  return {
    status: "healthy",
    targetMarginRate,
    fullPriceCents,
    recommendedPriceCents: chosen.priceCents,
    secondBestPriceCents: healthy[1]?.priceCents || null,
    netPayoutCents: chosen.revenueAfterCouponCents - chosen.totalFeesCents,
    pixPriceCents: chosen.pixPriceCents,
    promotionPercent: fullPriceCents > 0 ? Math.max(0, 1 - chosen.priceCents / fullPriceCents) : 0,
    breakdown: chosen,
  };
}

module.exports = {
  DEFAULT_PRICING_SETTINGS,
  FEE_RULES,
  normalizeSettings,
  getFeeRule,
  getEligibleCouponDiscount,
  getPixDiscountRate,
  roundUpToPsychologicalPrice,
  buildBreakdown,
  calculatePrice,
};
