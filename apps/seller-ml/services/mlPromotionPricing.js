"use strict";

function round2(value) {
  const num = Number(value || 0);
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function positiveNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function firstPositive(candidates) {
  for (const candidate of candidates) {
    const value = positiveNumber(candidate);
    if (value) return value;
  }
  return null;
}

function firstDiscountPercent(candidates) {
  for (const candidate of candidates) {
    const num = Number(candidate);
    if (Number.isFinite(num) && num > 0 && num < 100) {
      return round2(num);
    }
  }
  return null;
}

function computePromoPercent(originalPrice, currentPrice) {
  const original = Number(originalPrice || 0);
  const current = Number(currentPrice || 0);
  if (!(original > 0) || !(current > 0) || current >= original) return null;
  return round2(((original - current) / original) * 100);
}

function extractSalePriceInfo(payload) {
  const amount = firstPositive([
    payload?.amount,
    payload?.sale_price?.amount,
    payload?.price?.amount,
    Array.isArray(payload?.prices) ? payload.prices[0]?.amount : null,
  ]);

  const regularAmount = firstPositive([
    payload?.regular_amount,
    payload?.sale_price?.regular_amount,
    payload?.price?.regular_amount,
    Array.isArray(payload?.prices) ? payload.prices[0]?.regular_amount : null,
    payload?.metadata?.regular_amount,
    payload?.metadata?.original_price,
    payload?.list_price,
    payload?.base_price,
  ]);

  const discountPercent = firstDiscountPercent([
    payload?.discount_percentage,
    payload?.discount_percent,
    payload?.sale_price?.discount_percentage,
    payload?.sale_price?.discount_percent,
    payload?.price?.discount_percentage,
    payload?.price?.discount_percent,
    payload?.metadata?.discount_percentage,
    payload?.metadata?.discount_percent,
    payload?.metadata?.campaign_discount_percentage,
    payload?.metadata?.promotion_discount_percentage,
  ]);

  return {
    amount,
    regular_amount: regularAmount,
    discount_percent: discountPercent,
  };
}

function resolvePromotionSnapshot({
  itemPrice = null,
  itemOriginalPrice = null,
  salePriceInfo = null,
  itemPromotion = null,
} = {}) {
  const itemPriceValue = positiveNumber(itemPrice);
  const itemOriginalPriceValue = positiveNumber(itemOriginalPrice);
  const saleAmount = positiveNumber(salePriceInfo?.amount);
  const regularAmount = positiveNumber(salePriceInfo?.regular_amount);

  const promoCurrentPrice = positiveNumber(itemPromotion?.current_price);
  const promoOriginalPrice = positiveNumber(itemPromotion?.original_price);

  const currentPrice = firstPositive([saleAmount, promoCurrentPrice, itemPriceValue]);
  let basePrice = firstPositive([
    itemOriginalPriceValue,
    regularAmount,
    promoOriginalPrice,
    itemPriceValue,
  ]);

  let promoPercent = firstDiscountPercent([
    itemPromotion?.promo_pct,
    salePriceInfo?.discount_percent,
    computePromoPercent(basePrice, currentPrice),
  ]);

  if (!(basePrice > currentPrice) && promoPercent > 0 && currentPrice > 0) {
    basePrice = round2(currentPrice / (1 - Number(promoPercent) / 100));
  }

  if (!basePrice && currentPrice) basePrice = currentPrice;

  const promoActive =
    (promoPercent > 0 && basePrice > currentPrice) ||
    itemPromotion?.promo_active === true;

  if (promoActive && !promoPercent) {
    promoPercent = computePromoPercent(basePrice, currentPrice);
  }

  return {
    promo_active: !!promoActive,
    promo_pct: promoActive ? promoPercent ?? null : null,
    current_price: currentPrice || null,
    original_price: basePrice || null,
    promo_name: promoActive ? itemPromotion?.promo_name || "Promo atual" : null,
    promo_id: promoActive ? itemPromotion?.promo_id || null : null,
    promo_status: promoActive ? itemPromotion?.promo_status || "active" : null,
    promo_source: itemPromotion?.promo_source || "sale_price",
  };
}

module.exports = {
  round2,
  computePromoPercent,
  extractSalePriceInfo,
  resolvePromotionSnapshot,
};

