"use strict";

const OPERATION_COSTS = Object.freeze({
  "shopee.async.logistics": Object.freeze({ base: 5, perUnits: 1, unitBlock: 20 }),
  "shopee.async.products.status": Object.freeze({ base: 5, perUnits: 1, unitBlock: 20 }),
  "shopee.async.products.relaunch": Object.freeze({ base: 5, perUnits: 1, unitBlock: 20 }),
  "shopee.async.products.deadline": Object.freeze({ base: 5, perUnits: 1, unitBlock: 20 }),
  "shopee.ads.report": Object.freeze({ base: 3, perUnits: 0, unitBlock: 1 }),
  "shopee.ads.enrichment": Object.freeze({ base: 5, perUnits: 1, unitBlock: 20 }),
  "shopee.ads.apply": Object.freeze({ base: 10, perUnits: 2, unitBlock: 1 }),
  "shopee.ads.boost": Object.freeze({ base: 5, perUnits: 1, unitBlock: 10 }),
  "shopee.discounts.write": Object.freeze({ base: 5, perUnits: 1, unitBlock: 20 }),
  "shopee.discounts.publish": Object.freeze({ base: 10, perUnits: 1, unitBlock: 20 }),
  "shopee.discounts.close": Object.freeze({ base: 5, perUnits: 0, unitBlock: 1 }),
  "shopee.listing.preview": Object.freeze({ base: 5, perUnits: 0, unitBlock: 1 }),
  "shopee.listing.attributes": Object.freeze({ base: 2, perUnits: 0, unitBlock: 1 }),
  "shopee.listing.media": Object.freeze({ base: 2, perUnits: 1, unitBlock: 3 }),
  "shopee.listing.publish": Object.freeze({ base: 10, perUnits: 5, unitBlock: 1 }),
});

const ASYNC_ACTION_OPERATION_MAP = Object.freeze({
  "logistics.spx.enable": "shopee.async.logistics",
  "logistics.spx.disable": "shopee.async.logistics",
  "logistics.seller.enable": "shopee.async.logistics",
  "logistics.seller.disable": "shopee.async.logistics",
  "logistics.conflicts.keep_spx": "shopee.async.logistics",
  "logistics.conflicts.keep_seller": "shopee.async.logistics",
  "logistics.mapping.apply": "shopee.async.logistics",
  "logistics.configure": "shopee.async.logistics",
  "products.deadline.apply": "shopee.async.products.deadline",
  "products.relaunch.pause": "shopee.async.products.relaunch",
  "products.relaunch.delete": "shopee.async.products.relaunch",
  "products.status.bulk": "shopee.async.products.status",
});

function positiveInteger(value, fallback = 1) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function collectArraySizes(value, sizes = []) {
  if (!value || typeof value !== "object") return sizes;
  if (Array.isArray(value)) {
    sizes.push(value.length);
    value.slice(0, 20).forEach((item) => collectArraySizes(item, sizes));
    return sizes;
  }
  Object.values(value)
    .slice(0, 80)
    .forEach((item) => collectArraySizes(item, sizes));
  return sizes;
}

function inferUnitsFromPayload(payload = {}) {
  if (!payload || typeof payload !== "object") return 1;
  const candidates = [
    payload.units,
    payload.count,
    payload.total,
    payload.totalItems,
    payload.itemCount,
    payload.items?.length,
    payload.itemIds?.length,
    payload.ids?.length,
    payload.productIds?.length,
    payload.selectedIds?.length,
    payload.rows?.length,
    payload.files?.length,
  ];

  for (const candidate of candidates) {
    const parsed = positiveInteger(candidate, 0);
    if (parsed > 0) return parsed;
  }

  const nestedSizes = collectArraySizes(payload).filter((size) => size > 0);
  return nestedSizes.length ? Math.max(...nestedSizes) : 1;
}

function calculateOperationCredits(operationKey, { units = 1 } = {}) {
  const normalizedKey = String(operationKey || "").trim().toLowerCase();
  const definition = OPERATION_COSTS[normalizedKey];
  if (!definition) throw new Error(`unknown_shopee_credit_operation:${normalizedKey || "empty"}`);

  const normalizedUnits = positiveInteger(units, 1);
  const blocks = Math.ceil(normalizedUnits / Math.max(1, Number(definition.unitBlock || 1)));
  return Math.max(0, Number(definition.base || 0) + blocks * Number(definition.perUnits || 0));
}

function estimateShopeeOperationCredits(operationKey, payload = {}) {
  return calculateOperationCredits(operationKey, {
    units: inferUnitsFromPayload(payload),
  });
}

function operationKeyForAsyncAction(action) {
  return ASYNC_ACTION_OPERATION_MAP[String(action || "").trim().toLowerCase()] || null;
}

module.exports = {
  ASYNC_ACTION_OPERATION_MAP,
  OPERATION_COSTS,
  calculateOperationCredits,
  estimateShopeeOperationCredits,
  inferUnitsFromPayload,
  operationKeyForAsyncAction,
  __test: { asyncActionOperationMap: ASYNC_ACTION_OPERATION_MAP },
};
