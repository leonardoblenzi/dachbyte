"use strict";

const env = require("../config/env");
const magaluApiClient = require("./magaluApiClient");
const rateLimiter = require("./magaluRateLimiter");

function text(value, max = 500) { return String(value == null ? "" : value).trim().slice(0, max); }
function accountArgs(account) {
  return { accountId: Number(account.id), dachTenantId: String(account.dach_tenant_id) };
}
async function get(account, kind, path, options = {}) {
  await rateLimiter.waitFor(account.id, kind);
  return magaluApiClient.request(path, {
    method: "GET",
    ...accountArgs(account),
    attempts: options.attempts || 4,
    timeoutMs: options.timeoutMs || 15_000,
    headers: options.headers || {},
  });
}
async function listOrders(account, { offset = 0, limit = env.MAGALU_ORDER_SYNC_PAGE_SIZE } = {}) {
  const params = new URLSearchParams();
  params.set("_offset", String(Math.max(0, Number(offset) || 0)));
  params.set("_limit", String(Math.min(100, Math.max(1, Number(limit) || env.MAGALU_ORDER_SYNC_PAGE_SIZE))));
  params.set("_sort", "purchased_at:desc");
  return get(account, "order-read", `/seller/v1/orders?${params.toString()}`);
}
async function getOrder(account, code) {
  const normalized = text(code, 300);
  if (!normalized) throw new Error("Código do pedido ausente.");
  return get(account, "order-read", `/seller/v1/orders/${encodeURIComponent(normalized)}`);
}
async function listDeliveries(account, { channelId, code = null, status = null, from = null, to = null, offset = 0, limit = env.MAGALU_ORDER_SYNC_PAGE_SIZE } = {}) {
  const channel = text(channelId, 160);
  if (!channel) {
    const error = new Error("channel_id ausente para consultar entregas Magalu.");
    error.code = "MAGALU_DELIVERY_CHANNEL_REQUIRED";
    error.status = 409;
    throw error;
  }
  const params = new URLSearchParams();
  if (code) params.set("code", text(code, 300));
  if (status) params.set("status", text(status, 100));
  if (from) params.set("purchased_at__gte", String(from));
  if (to) params.set("purchased_at__lte", String(to));
  params.set("_offset", String(Math.max(0, Number(offset) || 0)));
  params.set("_limit", String(Math.min(100, Math.max(1, Number(limit) || env.MAGALU_ORDER_SYNC_PAGE_SIZE))));
  params.set("_sort", "purchased_at:desc");
  return get(account, "delivery-read", `/seller/v1/deliveries?${params.toString()}`, { headers: { "X-Channel-Id": channel } });
}
async function getDelivery(account, id, channelId) {
  const normalized = text(id, 300), channel = text(channelId, 160);
  if (!normalized || !channel) {
    const error = new Error("Entrega ou channel_id ausente.");
    error.code = "MAGALU_DELIVERY_ID_CHANNEL_REQUIRED";
    error.status = 400;
    throw error;
  }
  return get(account, "delivery-read", `/seller/v1/deliveries/${encodeURIComponent(normalized)}`, { headers: { "X-Channel-Id": channel } });
}
module.exports = { listOrders, getOrder, listDeliveries, getDelivery, _test: { text } };
