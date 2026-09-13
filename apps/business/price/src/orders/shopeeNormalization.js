"use strict";

const SENSITIVE_SHOPEE_KEY = /(buyer|recipient|invoice|address|email|phone|telephone|mobile|cpf|cnpj|document|credit.?card|card.?number|token|secret|authorization|cookie)/i;

function text(value) { const normalized = String(value ?? "").trim(); return normalized || null; }
function numberOrNull(value) { const result = Number(value); return Number.isFinite(result) ? result : null; }
function timestampOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 0 ? new Date(numeric * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function stripShopeeSensitiveData(value) {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripShopeeSensitiveData);
  const safe = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_SHOPEE_KEY.test(key)) continue;
    safe[key] = stripShopeeSensitiveData(child);
  }
  return safe;
}
function normalizeItem(item) {
  return { name: text(item?.item_name || item?.itemName), sku: text(item?.item_sku || item?.model_sku || item?.modelSku), quantity: numberOrNull(item?.model_quantity_purchased ?? item?.quantity ?? item?.modelQuantityPurchased) };
}
function normalizeShopeeOrder(detail, shopId) {
  const order = detail?.order || detail || {};
  const orderSn = text(order.order_sn || order.orderSn);
  const accountId = text(shopId);
  const createdAt = timestampOrNull(order.create_time ?? order.createTime);
  const modifiedAt = timestampOrNull(order.update_time ?? order.updateTime ?? order.pay_time ?? order.payTime);
  const items = Array.isArray(order.item_list) ? order.item_list : (Array.isArray(order.itemList) ? order.itemList : []);
  return {
    sourceOrderId: orderSn, status: text(order.order_status || order.orderStatus), orderDate: createdAt, modifiedAt,
    totalAmount: numberOrNull(order.total_amount ?? order.totalAmount), marketplace: "shopee", marketplaceOrderId: orderSn,
    marketplaceAccountId: accountId, marketplaceAccountSource: "shopee_sync", reconciliationStatus: "matched", matchConfidence: 1, matchReason: "shopee_sync",
    normalizedData: { source: "shopee", sourceOrderId: orderSn, shopId: accountId, status: text(order.order_status || order.orderStatus), orderDate: createdAt, modifiedAt, totalAmount: numberOrNull(order.total_amount ?? order.totalAmount), items: items.map(normalizeItem) },
    raw: stripShopeeSensitiveData(order),
  };
}

module.exports = { normalizeShopeeOrder, numberOrNull, timestampOrNull, stripShopeeSensitiveData };
