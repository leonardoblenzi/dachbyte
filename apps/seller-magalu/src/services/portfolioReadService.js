"use strict";
const env = require("../config/env");
const magaluApiClient = require("./magaluApiClient");
const rateLimiter = require("./magaluRateLimiter");
function pathSku(base, sku) { return `${base}/${encodeURIComponent(String(sku || "").trim())}`; }
async function requestRead(accountId, dachTenantId, kind, path, options = {}) {
  await rateLimiter.waitFor(accountId, kind);
  return magaluApiClient.request(path, { method: "GET", accountId, dachTenantId, attempts: options.attempts || 4, timeoutMs: options.timeoutMs || 15_000 });
}
async function getSeller(accountId, dachTenantId) { return requestRead(accountId, dachTenantId, "sku-read", "/seller/v1/portfolios/me"); }
async function listSkus(accountId, dachTenantId, { offset = 0, limit = env.MAGALU_SYNC_PAGE_SIZE, status = null, groupId = null } = {}) {
  const params = new URLSearchParams();
  params.set("_offset", String(Math.max(0, Number(offset) || 0)));
  params.set("_limit", String(Math.min(100, Math.max(1, Number(limit) || env.MAGALU_SYNC_PAGE_SIZE))));
  params.set("_sort", "updated_at:asc");
  if (status) params.set("status", String(status));
  if (groupId) params.set("group_id", String(groupId));
  return requestRead(accountId, dachTenantId, "sku-read", `/seller/v1/portfolios/skus?${params.toString()}`);
}
async function getSku(accountId, dachTenantId, sku) { return requestRead(accountId, dachTenantId, "sku-read", pathSku("/seller/v1/portfolios/skus", sku)); }
async function getPrice(accountId, dachTenantId, sku) { return requestRead(accountId, dachTenantId, "price-read", pathSku("/seller/v1/portfolios/prices", sku)); }
async function getStock(accountId, dachTenantId, sku) { return requestRead(accountId, dachTenantId, "stock-read", pathSku("/seller/v1/portfolios/stocks", sku)); }
module.exports = { getSeller, listSkus, getSku, getPrice, getStock };
