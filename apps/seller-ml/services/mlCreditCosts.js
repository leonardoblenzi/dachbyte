"use strict";

const OPERATION_COSTS = Object.freeze({
  "ads.filter": Object.freeze({ base: 5, perUnits: 0, unitBlock: 1 }),
  "promotions.apply": Object.freeze({ base: 2, perUnits: 1, unitBlock: 1 }),
  "promotions.remove": Object.freeze({ base: 2, perUnits: 1, unitBlock: 1 }),
  "promotions.validate": Object.freeze({ base: 2, perUnits: 1, unitBlock: 5 }),
  "wholesale.apply": Object.freeze({ base: 2, perUnits: 1, unitBlock: 1 }),
  "dimensions.validate": Object.freeze({ base: 2, perUnits: 1, unitBlock: 2 }),
  "mass-model.apply": Object.freeze({ base: 2, perUnits: 1, unitBlock: 1 }),
  "characteristics.apply": Object.freeze({ base: 2, perUnits: 1, unitBlock: 1 }),
  "production-time.lookup": Object.freeze({ base: 2, perUnits: 1, unitBlock: 5 }),
  "production-time.apply": Object.freeze({ base: 2, perUnits: 1, unitBlock: 1 }),
  "stock.scan": Object.freeze({ base: 2, perUnits: 1, unitBlock: 20 }),
  "listing.bulk-delete": Object.freeze({ base: 2, perUnits: 1, unitBlock: 1 }),
  "listing.clone": Object.freeze({ base: 0, perUnits: 5, unitBlock: 1 }),
  "listing.ai-analysis": Object.freeze({ base: 0, perUnits: 10, unitBlock: 1 }),
});

const ADS_ENRICHMENT_COSTS = Object.freeze({
  commercial_period: 5,
  visits: 3,
  ads: 5,
  promotions: 2,
  category: 2,
  variations: 3,
});

function positiveInteger(value, fallback = 0) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function calculateOperationCredits(operationKey, { units = 1, extras = [] } = {}) {
  const normalizedKey = String(operationKey || "").trim().toLowerCase();
  const definition = OPERATION_COSTS[normalizedKey];
  if (!definition) throw new Error(`unknown_credit_operation:${normalizedKey || "empty"}`);

  const normalizedUnits = positiveInteger(units, 1);
  const blocks = Math.ceil(normalizedUnits / Math.max(1, definition.unitBlock));
  const extrasCost = Array.from(new Set(Array.isArray(extras) ? extras : []))
    .map((key) => ADS_ENRICHMENT_COSTS[String(key || "").trim().toLowerCase()] || 0)
    .reduce((total, cost) => total + cost, 0);

  return Math.max(0, definition.base + blocks * definition.perUnits + extrasCost);
}

function adsFilterExtras(filters = {}) {
  return [
    filters.has_period ? "commercial_period" : null,
    filters.include_visits ? "visits" : null,
    filters.include_ads ? "ads" : null,
    filters.include_promos ? "promotions" : null,
    filters.include_category ? "category" : null,
    filters.detail_variations ? "variations" : null,
  ].filter(Boolean);
}

function estimateAdsFilterCredits(filters = {}) {
  return calculateOperationCredits("ads.filter", {
    units: 1,
    extras: adsFilterExtras(filters),
  });
}

module.exports = {
  ADS_ENRICHMENT_COSTS,
  OPERATION_COSTS,
  adsFilterExtras,
  calculateOperationCredits,
  estimateAdsFilterCredits,
};
