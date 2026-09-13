"use strict";

const SHOPEE_PUSH_CATEGORY_BY_CODE = Object.freeze({
  1: "shop_authorization",
  2: "shop_deauthorization",
  3: "order_status_update",
  4: "tracking_no_update",
  5: "shopee_updates",
  6: "banned_item",
  7: "item_promotion",
  8: "reserved_stock_change",
  9: "promotion_update",
  10: "webchat",
  11: "video_upload",
  12: "authorization_expiry",
  13: "brand_register_result",
  16: "violation_item",
  20: "purchase_order",
  22: "item_price_update",
  28: "shop_penalty_update",
  29: "return_updates",
});

const SHOPEE_WEBHOOK_CATEGORIES = Object.freeze(
  Array.from(
    new Set([
      ...Object.values(SHOPEE_PUSH_CATEGORY_BY_CODE),
      "unknown",
    ]),
  ),
);

function toPushCode(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function getShopeeWebhookCategoryFromCode(code) {
  const normalizedCode = toPushCode(code);
  if (normalizedCode == null) return "unknown";
  return SHOPEE_PUSH_CATEGORY_BY_CODE[normalizedCode] || "unknown";
}

function normalizeShopeeWebhookCategory(category) {
  const normalized = String(category || "")
    .trim()
    .toLowerCase();
  const aliases = {
    item_price_update_push: "item_price_update",
    item_price_update: "item_price_update",
    price_update: "item_price_update",
    order_status_update_push: "order_status_update",
    tracking_no_update_push: "tracking_no_update",
    trackingno_push: "tracking_no_update",
    promotionn_update_push: "promotion_update",
    promotion_update_push: "promotion_update",
    reserved_stock_change_push: "reserved_stock_change",
    shop_penalty_update_push: "shop_penalty_update",
    shop_penalty_update: "shop_penalty_update",
    penalty_update: "shop_penalty_update",
    shopee_updates_push: "shopee_updates",
    shopee_updates: "shopee_updates",
    shopee_update: "shopee_updates",
    official_shopee_updates: "shopee_updates",
    purchase_order_push: "purchase_order",
    purchase_order: "purchase_order",
    violation_item_push: "violation_item",
    violation_item: "violation_item",
    return_updates_push: "return_updates",
    return_updates: "return_updates",
    return_refund_update: "return_updates",
  };
  if (aliases[normalized]) {
    return aliases[normalized];
  }
  if (SHOPEE_WEBHOOK_CATEGORIES.includes(normalized)) {
    return normalized;
  }
  return "unknown";
}

function getShopeeWebhookCategories() {
  return [...SHOPEE_WEBHOOK_CATEGORIES];
}

module.exports = {
  SHOPEE_PUSH_CATEGORY_BY_CODE,
  getShopeeWebhookCategoryFromCode,
  normalizeShopeeWebhookCategory,
  getShopeeWebhookCategories,
};
