"use strict";

const SENSITIVE_KEYS = new Set([
  "document", "document_number", "cpf", "cnpj", "email", "phone", "phones",
  "street", "number", "complement", "reference", "recipient", "address",
  "raw_body", "signature_header", "authorization", "access_token", "refresh_token",
]);

function text(value, max = 1000) {
  return String(value == null ? "" : value).trim().slice(0, max);
}
function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function dateValue(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function dateOnlyValue(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}
function sanitizeOperational(value, depth = 0) {
  if (depth > 8) return null;
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeOperational(item, depth + 1));
  if (typeof value !== "object") return null;
  const out = {};
  for (const [rawKey, child] of Object.entries(value)) {
    const key = String(rawKey || "");
    if (SENSITIVE_KEYS.has(key.toLowerCase())) continue;
    out[key] = sanitizeOperational(child, depth + 1);
  }
  return out;
}
function moneyValue(payload) {
  if (payload == null) return null;
  if (typeof payload === "number" || typeof payload === "string") return number(payload);
  if (typeof payload !== "object") return null;
  return number(payload.value ?? payload.total ?? payload.amount);
}
function moneyPart(payload) {
  if (!payload || typeof payload !== "object") return { total: null, currency: null, normalizer: null };
  const total = payload.total && typeof payload.total === "object" ? payload.total : payload;
  return {
    total: moneyValue(total),
    currency: text(total?.currency || payload.currency, 12) || null,
    normalizer: number(total?.normalizer ?? payload.normalizer),
  };
}
function itemKey(item, index) {
  return text(item?.id || item?.info?.id || item?.sequencial || item?.sku || item?.info?.sku || `item-${index}`, 220);
}
function normalizeItem(item, index = 0) {
  const amount = moneyPart(item?.amounts);
  const unit = item?.unit_price || {};
  return {
    item_key: itemKey(item, index),
    sku: text(item?.sku || item?.info?.sku, 200) || null,
    remote_item_id: text(item?.id || item?.info?.id, 300) || null,
    name: text(item?.name || item?.info?.name || item?.info?.description, 500) || null,
    brand: text(item?.brand || item?.info?.brand, 300) || null,
    quantity: number(item?.quantity),
    measure_unit: text(item?.measure_unit, 50) || null,
    unit_price: number(unit?.value),
    amount_total: amount.total,
    amount_currency: amount.currency || text(unit?.currency, 12) || null,
    amount_normalizer: amount.normalizer ?? number(unit?.normalizer),
    operational_payload: sanitizeOperational(item),
  };
}
function orderCode(payload) {
  return text(payload?.code || payload?.order?.code || payload?.order_code || payload?.id, 300);
}
function orderChannel(payload) {
  return text(payload?.channel?.id || payload?.order?.channel?.id, 160) || null;
}
function normalizeOrder(payload) {
  const code = orderCode(payload);
  if (!code) return null;
  const amount = moneyPart(payload?.amounts);
  const itemsPresent = Array.isArray(payload?.items);
  const items = itemsPresent ? payload.items.map(normalizeItem) : [];
  return {
    code,
    remote_id: text(payload?.id || payload?.order?.id, 300) || null,
    channel_id: orderChannel(payload),
    status: text(payload?.status, 100) || null,
    purchased_at: dateValue(payload?.purchased_at || payload?.created_at),
    remote_updated_at: dateValue(payload?.updated_at),
    amount_total: amount.total,
    amount_currency: amount.currency,
    amount_normalizer: amount.normalizer,
    item_count: items.length,
    items_present: itemsPresent,
    operational_payload: sanitizeOperational(payload),
    items,
  };
}
function normalizeDelivery(payload) {
  const remoteId = text(payload?.id || payload?.code, 300);
  if (!remoteId) return null;
  const amount = moneyPart(payload?.amounts);
  const shipping = payload?.shipping || {};
  const provider = shipping?.provider || {};
  const providerExtras = provider?.extras || {};
  const itemsPresent = Array.isArray(payload?.items);
  const items = itemsPresent ? payload.items.map(normalizeItem) : [];
  return {
    remote_id: remoteId,
    order_code: orderCode(payload?.order || payload) || text(payload?.code, 300) || null,
    channel_id: orderChannel(payload),
    status: text(payload?.status, 100) || null,
    purchased_at: dateValue(payload?.purchased_at),
    handling_limit_at: dateValue(payload?.handling_time?.limit_date || shipping?.handling_time?.limit_date),
    delivery_limit_at: dateOnlyValue(shipping?.deadline?.limit_date || payload?.deadline?.limit_date),
    posting_at: dateValue(payload?.posting_at || payload?.posting_date || shipping?.posting_date),
    provider_id: text(provider?.id, 200) || null,
    provider_name: text(provider?.name || provider?.description, 300) || null,
    shipping_type: text(providerExtras?.shipping_type, 200) || null,
    shipping_name: text(providerExtras?.shipping_name, 300) || null,
    is_mle: typeof providerExtras?.is_mle === "boolean" ? providerExtras.is_mle : null,
    is_fulfillment: typeof providerExtras?.is_fulfillment === "boolean" ? providerExtras.is_fulfillment : null,
    tracking_code: text(shipping?.tracking?.code, 300) || null,
    tracking_url: text(shipping?.tracking?.url, 1200) || null,
    amount_total: amount.total,
    amount_freight: moneyValue(payload?.amounts?.freight?.total ?? payload?.amounts?.freight),
    amount_discount: moneyValue(payload?.amounts?.discount?.total ?? payload?.amounts?.discount),
    amount_currency: amount.currency,
    amount_normalizer: amount.normalizer,
    item_count: items.length,
    items_present: itemsPresent,
    operational_payload: sanitizeOperational(payload),
    items,
  };
}
function listRows(response) {
  const data = response?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.orders)) return data.orders;
  return [];
}
function nextOffset(response, fallback) {
  const data = response?.data || {};
  const next = data?.meta?.links?.next || data?.links?.next || null;
  if (!next) return null;
  try {
    const url = new URL(String(next), "https://api.magalu.com");
    const parsed = Number.parseInt(url.searchParams.get("_offset") || "", 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  } catch (_error) {
    return fallback;
  }
}

module.exports = {
  sanitizeOperational, normalizeOrder, normalizeDelivery, normalizeItem, orderCode, orderChannel, listRows, nextOffset,
  _test: { text, number, dateValue, dateOnlyValue, moneyValue, moneyPart, itemKey, SENSITIVE_KEYS },
};
