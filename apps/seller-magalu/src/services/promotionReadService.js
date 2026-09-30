"use strict";

const magaluApiClient = require("./magaluApiClient");

const CACHE_TTL_MS = 30_000;
const cache = new Map();

function first(value, keys) {
  for (const key of keys) {
    if (value?.[key] != null && value[key] !== "") return value[key];
  }
  return null;
}

function listOf(payload) {
  if (Array.isArray(payload?.promos)) return payload.promos;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function normalizePromotion(row) {
  return {
    id: String(first(row, ["id", "promotion_id", "code"]) || ""),
    name: String(first(row, ["name", "title", "promotion_name"]) || "Promoção sem nome"),
    type: first(row, ["type", "promotion_type"]),
    origin: first(row, ["origin", "source"]),
    status: first(row, ["status", "lifecycle_status"]),
    benefits: Array.isArray(row?.benefits) ? row.benefits : [],
    seller_contribution: first(row, ["seller_contribution", "seller_investment"]),
    adhesion_deadline_at: first(row, ["adhesion_deadline_at", "subscription_deadline_at", "join_until"]),
    starts_at: first(row, ["starts_at", "start_at", "start_date"]),
    ends_at: first(row, ["ends_at", "end_at", "end_date"]),
    participation_status: first(row, ["participation_status", "subscription_status"]),
  };
}

function keyFor(accountId, suffix) {
  return `${Number(accountId)}:${suffix}`;
}

function cached(key, force) {
  const entry = cache.get(key);
  if (force || !entry || entry.expiresAt <= Date.now()) return null;
  return entry.value;
}

function save(key, value) {
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
}

async function list(account, { force = false } = {}) {
  const key = keyFor(account?.id, "list");
  const existing = cached(key, force);
  if (existing) return existing;
  const response = await magaluApiClient.request("/seller/v1/promotions", {
    method: "GET",
    accountId: account.id,
    dachTenantId: account.dach_tenant_id,
    attempts: 2,
  });
  return save(key, {
    promotions: listOf(response.data).map(normalizePromotion).filter((promotion) => promotion.id),
    request_id: response.requestId || null,
  });
}

async function detail(account, promotionId, { force = false } = {}) {
  const id = String(promotionId || "").trim();
  if (!id) throw new Error("promotion_id_required");

  const key = keyFor(account?.id, `detail:${id}`);
  const existing = cached(key, force);
  if (existing) return existing;

  const response = await magaluApiClient.request(
    `/seller/v1/promotions/${encodeURIComponent(id)}`,
    {
      method: "GET",
      accountId: account.id,
      dachTenantId: account.dach_tenant_id,
      attempts: 2,
    },
  );
  const row = response.data?.promotion || response.data || {};
  return save(key, {
    promotion: normalizePromotion(row),
    request_id: response.requestId || null,
  });
}

function clearAccount(accountId) {
  const prefix = `${Number(accountId)}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

module.exports = { list, detail, clearAccount, normalizePromotion, _test: { first, listOf } };
