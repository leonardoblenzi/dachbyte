"use strict";
function text(value) { return String(value == null ? "" : value).trim(); }
function numberOrNull(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function payloadObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function skuFields(payload) {
  const data = payloadObject(payload);
  return { sku: text(data.sku), title: text(data.title) || null, status: text(data.status) || null,
    active: typeof data.active === "boolean" ? data.active : null, brand: text(data.brand) || null,
    groupId: text(data.group?.id) || null, categoryId: text(data.category?.id) || null,
    fulfillment: typeof data.fulfillment === "boolean" ? data.fulfillment : null,
    createdAt: text(data.created_at) || null, updatedAt: text(data.updated_at) || null };
}
function priceFields(payload) { const data = payloadObject(payload); return { price: numberOrNull(data.price), listPrice: numberOrNull(data.list_price) }; }
function stockQuantity(payload) {
  const data = payloadObject(payload);
  const candidates = [data.quantity, data.available_quantity, data.available, data.stock, data.amount, data?.inventory?.quantity, data?.inventory?.available_quantity];
  for (const candidate of candidates) { const parsed = numberOrNull(candidate); if (parsed !== null) return parsed; }
  return null;
}
module.exports = { text, numberOrNull, payloadObject, skuFields, priceFields, stockQuantity };
