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
function priceFields(payload) {
  const data = payloadObject(payload);
  if (Array.isArray(data.results)) {
    const result = data.results.length === 1 ? payloadObject(data.results[0]) : {};
    const normalizer = Number(result.normalizer);
    if (!Number.isFinite(normalizer) || normalizer <= 0) return { price: null, listPrice: null };
    const validMinorUnits = (value) => {
      if (value == null) return null;
      const amount = numberOrNull(value);
      return amount !== null && amount >= 0 && amount <= 99_999_999 ? amount : null;
    };
    const price = validMinorUnits(result.price);
    const listPrice = validMinorUnits(result.list_price);
    return { price: price == null ? null : price / normalizer, listPrice: listPrice == null ? null : listPrice / normalizer };
  }
  return {
    price: data.price == null ? null : numberOrNull(data.price),
    listPrice: data.list_price == null ? null : numberOrNull(data.list_price),
  };
}
function stockQuantity(payload) {
  const data = payloadObject(payload);
  const candidates = [data.quantity, data.available_quantity, data.available, data.stock, data.amount, data?.inventory?.quantity, data?.inventory?.available_quantity];
  for (const candidate of candidates) { const parsed = numberOrNull(candidate); if (parsed !== null) return parsed; }
  return null;
}
module.exports = { text, numberOrNull, payloadObject, skuFields, priceFields, stockQuantity };
