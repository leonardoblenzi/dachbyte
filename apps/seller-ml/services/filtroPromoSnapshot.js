"use strict";

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizeIds(row) {
  const ids = [
    row?.item_id,
    row?.mlb,
    ...(Array.isArray(row?.related_item_ids) ? row.related_item_ids : []),
  ];
  return [...new Set(ids.map((id) => String(id || "").trim().toUpperCase()).filter(Boolean))];
}

function mergePromotion(campaignPromo, exactPromo) {
  if (!campaignPromo) {
    if (!exactPromo || exactPromo.promo_active !== true) return null;
    return {
      promo_active: true,
      promo_pct: finite(exactPromo.promo_pct),
      current_price: finite(exactPromo.current_price),
      original_price: finite(exactPromo.original_price),
      promo_name: exactPromo.promo_name || "Promo atual",
      promo_id: exactPromo.promo_id || null,
      promo_status: exactPromo.promo_status || "active",
      promo_source: exactPromo.promo_source || "sale_price",
    };
  }
  if (!exactPromo || exactPromo.promo_active !== true) return campaignPromo;
  return {
    ...campaignPromo,
    promo_active: true,
    promo_pct: finite(exactPromo.promo_pct) ?? finite(campaignPromo.promo_pct),
    current_price: finite(exactPromo.current_price),
    original_price: finite(exactPromo.original_price),
    promo_name: exactPromo.promo_name || campaignPromo.promo_name,
    promo_id: exactPromo.promo_id || campaignPromo.promo_id,
    promo_status: exactPromo.promo_status || campaignPromo.promo_status || "active",
    promo_source: exactPromo.promo_source || "sale_price",
  };
}

function applyPromotionSnapshot(rows, promotionMap, exactPricingMap = null) {
  const targetRows = Array.isArray(rows) ? rows : [];
  const map = promotionMap instanceof Map ? promotionMap : new Map();
  const exactMap = exactPricingMap instanceof Map ? exactPricingMap : new Map();

  for (const row of targetRows) {
    const entries = normalizeIds(row)
      .map((id) => mergePromotion(map.get(id) || null, exactMap.get(id) || null))
      .filter(Boolean)
      .sort((a, b) => Number(b?.promo_pct || 0) - Number(a?.promo_pct || 0));
    const promo = entries[0] || null;
    const exactCurrentPrice = finite(promo?.current_price);
    const exactOriginalPrice = finite(promo?.original_price);
    if (promo && exactCurrentPrice > 0) {
      row.current_price_cents = Math.round(exactCurrentPrice * 100);
    }
    if (promo && exactOriginalPrice > 0) {
      row.original_price_cents = Math.round(exactOriginalPrice * 100);
    }
    const currentCents = finite(row?.current_price_cents);
    const originalCents = finite(row?.original_price_cents);
    const promoPct = finite(promo?.promo_pct);
    const promoActive = !!promo;

    let basePrice = originalCents > 0 ? round2(originalCents / 100) : null;
    const currentPrice = currentCents > 0 ? round2(currentCents / 100) : null;
    if (promoActive && basePrice == null && currentPrice != null && promoPct > 0 && promoPct < 100) {
      basePrice = round2(currentPrice / (1 - promoPct / 100));
    }
    if (basePrice == null) basePrice = currentPrice;

    row.promo_active = promoActive;
    row.promo_pct = promoActive ? promoPct : null;
    row.promo_name = promoActive ? promo?.promo_name || "Promo atual" : null;
    row.promo_status = promoActive ? promo?.promo_status || "active" : "sem_promocao";
    row.promo_id = promoActive ? promo?.promo_id || null : null;
    row.promo_base_price = basePrice;
    row.promo_current_price = promoActive ? currentPrice : null;
    row.promo_snapshot_source = promo?.promo_source || "seller_promotions";
  }

  return targetRows;
}

module.exports = {
  applyPromotionSnapshot,
  mergePromotion,
  normalizeIds,
};
