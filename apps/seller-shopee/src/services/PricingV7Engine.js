"use strict";

const {
  calculatePrice,
  buildBreakdown,
  getEligibleCouponDiscount,
  normalizeSettings: normalizeSafeSettings,
  roundUpToPsychologicalPrice,
} = require("./PricingV6Engine");

const MIN_CALIBRATION_QUALITY = 0.75;

function toCents(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
}

function normalizeRate(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed > 1 ? parsed / 100 : parsed));
}

function normalizeMode(value) {
  const mode = String(value || "HYBRID").trim().toUpperCase();
  return ["SAFE", "CALIBRATED", "HYBRID"].includes(mode) ? mode : "HYBRID";
}

function normalizeConfidenceMode(value) {
  return String(value || "AUTO").trim().toUpperCase() === "MANUAL"
    ? "MANUAL"
    : "AUTO";
}

function normalizeCalibration(calibration = {}, settings = {}) {
  const source = calibration && typeof calibration === "object" ? calibration : {};
  const sampleSize = Math.max(0, Math.round(Number(source.sampleSize || 0)));
  const effectiveSampleSize = Math.max(0, Number(source.effectiveSampleSize || sampleSize));
  const averageQuality = Math.max(0, Math.min(1, Number(source.averageQuality || 0)));
  const stabilityScore = Math.max(0, Math.min(1, Number(source.stabilityScore || 0)));
  const minimumQuality = normalizeRate(settings.minQuality, MIN_CALIBRATION_QUALITY);
  const valid = sampleSize > 0
    && effectiveSampleSize > 0
    && averageQuality >= minimumQuality
    && Number(source.gmvFactor) > 0
    && Number(source.payoutGmvFactor) > 0;
  let alphaMax = 0.15;
  if (effectiveSampleSize >= 50) alphaMax = 0.85;
  else if (effectiveSampleSize >= 20) alphaMax = 0.7;
  else if (effectiveSampleSize >= 5) alphaMax = 0.5;
  const confidenceMode = normalizeConfidenceMode(settings.confidenceMode);
  const alpha = confidenceMode === "MANUAL"
    ? normalizeRate(settings.manualAlpha, 0)
    : alphaMax * averageQuality * stabilityScore;
  return {
    valid,
    scope: String(source.scope || "SAFE"),
    sampleSize,
    effectiveSampleSize,
    averageQuality,
    stabilityScore,
    gmvFactor: Number(source.gmvFactor || 0),
    payoutGmvFactor: Number(source.payoutGmvFactor || 0),
    alpha: Math.max(0, Math.min(1, alpha)),
  };
}

function calculateRealizedOrder(input = {}) {
  const promotionalPriceCents = toCents(input.promotionalPriceCents);
  const buyerShippingCents = toCents(input.buyerShippingCents);
  const sellerCouponCents = toCents(input.sellerCouponCents);
  const platformCouponCents = toCents(input.platformCouponCents);
  const coinsCents = toCents(input.coinsCents);
  const gmvPaidCents = toCents(input.gmvPaidCents);
  const payoutCents = toCents(input.payoutCents);
  const taxCents = toCents(input.taxCents);
  const cmvCents = toCents(input.cmvCents);
  const adsCents = toCents(input.adsCents);
  const returnCostCents = toCents(input.returnCostCents);
  const externalCostCents = toCents(input.externalCostCents);
  const checkoutExpectedCents = promotionalPriceCents + buyerShippingCents
    - sellerCouponCents - platformCouponCents - coinsCents;
  const profitCents = payoutCents - cmvCents - taxCents - adsCents - returnCostCents - externalCostCents;
  const sellerNetRevenueCents = Math.max(0, promotionalPriceCents - sellerCouponCents);
  return {
    ...input,
    checkoutExpectedCents,
    checkoutDeltaCents: checkoutExpectedCents - gmvPaidCents,
    taxBaseCents: gmvPaidCents,
    taxEffectiveRate: gmvPaidCents > 0 ? taxCents / gmvPaidCents : 0,
    sellerNetRevenueCents,
    gmvFactor: sellerNetRevenueCents > 0 ? gmvPaidCents / sellerNetRevenueCents : 0,
    payoutGmvFactor: gmvPaidCents > 0 ? payoutCents / gmvPaidCents : 0,
    sellerRetentionFactor: sellerNetRevenueCents > 0 ? payoutCents / sellerNetRevenueCents : 0,
    effectiveMarketplaceTake: gmvPaidCents > 0 ? 1 - payoutCents / gmvPaidCents : 0,
    profitCents,
    marginRate: gmvPaidCents > 0 ? profitCents / gmvPaidCents : 0,
  };
}

function buildCalibratedBreakdown({ priceCents, costCents, logisticsCostCents, otherFixedCostCents, safeSettings, calibration }) {
  const price = toCents(priceCents);
  const coupon = getEligibleCouponDiscount(price, safeSettings.coupons);
  const sellerNetRevenueCents = Math.max(0, price - coupon.discountCents);
  const gmvCents = Math.max(0, Math.round(sellerNetRevenueCents * calibration.gmvFactor));
  const payoutCents = Math.max(0, Math.round(gmvCents * calibration.payoutGmvFactor));
  const taxCents = Math.round(gmvCents * safeSettings.taxRate);
  const variableCostCents = Math.round(gmvCents * safeSettings.variableCostRate);
  const costsCents = toCents(costCents) + toCents(logisticsCostCents) + toCents(otherFixedCostCents);
  const contributionCents = payoutCents - taxCents - variableCostCents - costsCents;
  return {
    priceCents: price,
    couponDiscountCents: coupon.discountCents,
    coupon: coupon.coupon,
    sellerNetRevenueCents,
    gmvCents,
    payoutCents,
    taxBaseCents: gmvCents,
    taxCents,
    variableCostCents,
    costsCents,
    contributionCents,
    marginRate: gmvCents > 0 ? contributionCents / gmvCents : -1,
  };
}

function buildHybridBreakdown({ priceCents, costCents, logisticsCostCents, otherFixedCostCents, safeSettings, calibration }) {
  const safeBreakdown = buildBreakdown({
    priceCents,
    costCents,
    logisticsCostCents,
    otherFixedCostCents,
    settings: safeSettings,
  });
  const calibrated = buildCalibratedBreakdown({ priceCents, costCents, logisticsCostCents, otherFixedCostCents, safeSettings, calibration });
  const alpha = calibration.alpha;
  const payoutCents = Math.round((1 - alpha) * (safeBreakdown.revenueAfterCouponCents - safeBreakdown.commissionCents - safeBreakdown.fixedFeeCents - safeBreakdown.campaignCents) + alpha * calibrated.payoutCents);
  const gmvCents = Math.round((1 - alpha) * safeBreakdown.revenueAfterCouponCents + alpha * calibrated.gmvCents);
  const taxCents = Math.round(gmvCents * safeSettings.taxRate);
  const variableCostCents = Math.round(gmvCents * safeSettings.variableCostRate);
  const costsCents = safeBreakdown.costsCents;
  const contributionCents = payoutCents - taxCents - variableCostCents - costsCents;
  return {
    priceCents: toCents(priceCents),
    gmvCents,
    payoutCents,
    taxBaseCents: gmvCents,
    taxCents,
    variableCostCents,
    costsCents,
    contributionCents,
    marginRate: gmvCents > 0 ? contributionCents / gmvCents : -1,
    alpha,
  };
}

function findMinimumScenario({ type, safePriceCents, input, safeSettings, calibration, targetMarginRate }) {
  const build = type === "CALIBRATED" ? buildCalibratedBreakdown : buildHybridBreakdown;
  const costsCents = toCents(input.costCents) + toCents(input.logisticsCostCents) + toCents(input.otherFixedCostCents);
  const retainedRate = type === "CALIBRATED"
    ? calibration.gmvFactor * (calibration.payoutGmvFactor - safeSettings.taxRate - safeSettings.variableCostRate - targetMarginRate)
    : Math.max(0.01, (1 - calibration.alpha) * (1 - safeSettings.taxRate - safeSettings.variableCostRate) + calibration.alpha * calibration.gmvFactor * (calibration.payoutGmvFactor - safeSettings.taxRate - safeSettings.variableCostRate - targetMarginRate));
  const estimated = retainedRate > 0 ? Math.ceil(costsCents / retainedRate) : safePriceCents;
  const candidates = new Set([safePriceCents, estimated]);
  for (let delta = -1000; delta <= 3000; delta += 100) candidates.add(Math.max(1, estimated + delta));
  const evaluations = Array.from(candidates)
    .map((candidate) => roundUpToPsychologicalPrice(candidate, safeSettings.psychologicalEndings))
    .filter((candidate) => candidate > 0)
    .map((priceCents) => build({ priceCents, costCents: input.costCents, logisticsCostCents: input.logisticsCostCents, otherFixedCostCents: input.otherFixedCostCents, safeSettings, calibration }))
    .filter((row) => row.marginRate + 0.000001 >= targetMarginRate)
    .sort((left, right) => left.priceCents - right.priceCents);
  const breakdown = evaluations[0] || build({ priceCents: safePriceCents, costCents: input.costCents, logisticsCostCents: input.logisticsCostCents, otherFixedCostCents: input.otherFixedCostCents, safeSettings, calibration });
  return { priceCents: breakdown.priceCents, marginRate: breakdown.marginRate, breakdown };
}

function simulateV7SalePrice(input = {}) {
  const safeSettings = normalizeSafeSettings(input.settings);
  const priceCents = toCents(input.priceCents);
  const safeBreakdown = buildBreakdown({
    priceCents,
    costCents: input.costCents,
    logisticsCostCents: input.logisticsCostCents,
    otherFixedCostCents: input.otherFixedCostCents,
    settings: safeSettings,
  });
  const safe = {
    ...safeBreakdown,
    gmvCents: safeBreakdown.revenueAfterCouponCents,
    payoutCents: safeBreakdown.revenueAfterCouponCents - safeBreakdown.commissionCents - safeBreakdown.fixedFeeCents - safeBreakdown.campaignCents,
    taxBaseCents: safeBreakdown.revenueAfterCouponCents,
  };
  const calibration = normalizeCalibration(input.calibration, input.settings);
  if (!calibration.valid) {
    return { mode: "SAFE", breakdown: safe, marginRate: safe.marginRate, netPayoutCents: safe.payoutCents, calibration, warnings: ["FALLBACK_SEGURO"] };
  }
  const calibrated = buildCalibratedBreakdown({ ...input, priceCents, safeSettings, calibration });
  const hybrid = calibration.alpha === 0 ? safe : calibration.alpha === 1 ? calibrated : buildHybridBreakdown({ ...input, priceCents, safeSettings, calibration });
  const mode = normalizeMode(input.settings?.engineMode);
  const breakdown = mode === "CALIBRATED" ? calibrated : mode === "HYBRID" ? hybrid : safe;
  return {
    mode,
    breakdown,
    marginRate: breakdown.marginRate,
    netPayoutCents: breakdown.payoutCents,
    calibration,
    warnings: calibration.alpha < 0.5 ? ["AMOSTRA_BAIXA"] : [],
  };
}

function calculateV7Price(input = {}) {
  const safeSettings = normalizeSafeSettings(input.settings);
  const targetMarginRate = normalizeRate(input.targetMarginRate, safeSettings.targetMarginRate);
  const safeRaw = calculatePrice({ ...input, targetMarginRate, settings: safeSettings });
  if (!safeRaw.breakdown || !safeRaw.recommendedPriceCents) {
    return { status: "unpriceable", selected: { mode: "SAFE", priceCents: null }, warnings: ["FALLBACK_SEGURO"] };
  }
  const safe = { priceCents: safeRaw.recommendedPriceCents, marginRate: safeRaw.breakdown.marginRate, breakdown: safeRaw.breakdown };
  const calibration = normalizeCalibration(input.calibration, input.settings);
  if (!calibration.valid) {
    return { status: "healthy", safe, calibrated: null, hybrid: null, selected: { ...safe, mode: "SAFE" }, calibration, warnings: ["FALLBACK_SEGURO", "AMOSTRA_BAIXA"] };
  }
  const calibrated = findMinimumScenario({ type: "CALIBRATED", safePriceCents: safe.priceCents, input, safeSettings, calibration, targetMarginRate });
  const hybrid = calibration.alpha === 0
    ? { ...safe, breakdown: { ...safe.breakdown, alpha: 0 } }
    : calibration.alpha === 1
      ? { ...calibrated, breakdown: { ...calibrated.breakdown, alpha: 1 } }
      : findMinimumScenario({ type: "HYBRID", safePriceCents: safe.priceCents, input, safeSettings, calibration, targetMarginRate });
  const requestedMode = normalizeMode(input.settings?.engineMode);
  const chosen = requestedMode === "CALIBRATED" ? calibrated : requestedMode === "HYBRID" ? hybrid : safe;
  return {
    status: "healthy",
    safe,
    calibrated,
    hybrid,
    selected: { ...chosen, mode: requestedMode },
    calibration,
    warnings: calibration.alpha < 0.5 ? ["AMOSTRA_BAIXA"] : [],
  };
}

module.exports = {
  calculateRealizedOrder,
  calculateV7Price,
  simulateV7SalePrice,
  normalizeCalibration,
};
