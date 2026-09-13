"use strict";

const fetch = require("node-fetch");
const db = require("../db/db");
const TokenService = require("./tokenService");
const { decryptToken } = require("./tokenCrypto");
const { getSharedRedis } = require("../lib/redisClient");

const ttlFromEnv = Number(process.env.PROMO_OFFER_REF_TTL_SEC);
const maxFromEnv = Number(process.env.PROMO_OFFER_REF_MAX_PER_BUCKET);
const OFFER_REF_TTL_SECONDS =
  Number.isFinite(ttlFromEnv) && ttlFromEnv > 0 ? ttlFromEnv : 72 * 60 * 60;
const OFFER_REF_MAX_PER_BUCKET =
  Number.isFinite(maxFromEnv) && maxFromEnv > 0 ? maxFromEnv : 50;

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizePromotionType(value) {
  const text = String(value || "").trim().toUpperCase();
  return text || null;
}

function nowIso() {
  return new Date().toISOString();
}

function redisClient() {
  return getSharedRedis("app");
}

function itemPromotionBucketKey({ meli_conta_id, item_id, promotion_id }) {
  const conta = String(meli_conta_id || "").trim();
  const item = String(item_id || "").trim().toUpperCase();
  const promo = String(promotion_id || "__none__").trim();
  return `promo:offer_refs:v1:acct:${conta}:item:${item}:promo:${promo}`;
}

function itemPromotionIndexKey({ meli_conta_id, item_id }) {
  const conta = String(meli_conta_id || "").trim();
  const item = String(item_id || "").trim().toUpperCase();
  return `promo:offer_refs:v1:index:acct:${conta}:item:${item}`;
}

function bucketPromotionToken(promotion_id) {
  return String(promotion_id || "__none__").trim();
}

function buildMlUrl(resource = "") {
  const path = String(resource || "").trim();
  if (!path) return null;
  const absolute = /^https?:\/\//i.test(path)
    ? path
    : `https://api.mercadolibre.com${path.startsWith("/") ? path : `/${path}`}`;

  if (!/seller-promotions\//i.test(absolute)) return absolute;
  if (/[?&]app_version=/i.test(absolute)) return absolute;
  return `${absolute}${absolute.includes("?") ? "&" : "?"}app_version=v2`;
}

async function authFetch(url, mlCreds = {}, init = {}) {
  const token = await TokenService.renovarTokenSeNecessario(mlCreds);
  const headers = {
    Accept: "application/json",
    ...(init.headers || {}),
    Authorization: `Bearer ${token}`,
  };
  return fetch(url, { ...init, headers });
}

function decodeStoredToken(raw) {
  if (!raw) return null;
  try {
    return decryptToken(raw);
  } catch {
    return raw;
  }
}

async function listAccountsForMeliUser(meliUserId) {
  const uid = toNum(meliUserId);
  if (!uid) return [];

  const { rows } = await db.query(
    `
      SELECT
        mc.id AS meli_conta_id,
        mc.meli_user_id,
        mc.apelido,
        mc.site_id,
        mc.status,
        mt.access_token,
        mt.access_expires_at,
        mt.refresh_token,
        mt.scope
      FROM meli_contas mc
      LEFT JOIN meli_tokens mt
        ON mt.meli_conta_id = mc.id
      WHERE mc.meli_user_id = $1
      ORDER BY mc.id DESC
    `,
    [uid],
  );

  return rows.map((row) => ({
    meli_conta_id: Number(row.meli_conta_id),
    meli_user_id: Number(row.meli_user_id),
    apelido: row.apelido || null,
    site_id: row.site_id || "MLB",
    status: row.status || null,
    access_token: decodeStoredToken(row.access_token),
    access_expires_at: row.access_expires_at || null,
    refresh_token: decodeStoredToken(row.refresh_token),
    scope: row.scope || null,
  }));
}

function normalizeOfferPayload(payload = {}, meta = {}) {
  return {
    meli_conta_id: toNum(meta.meli_conta_id),
    meli_user_id: toNum(meta.meli_user_id),
    item_id: String(
      payload.item_id ||
        payload.item?.id ||
        payload.itemId ||
        payload.item?.item_id ||
        "",
    ).trim() || null,
    promotion_id: String(
      payload.promotion_id ||
        payload.promotion?.id ||
        payload.id ||
        payload.promotionId ||
        "",
    ).trim() || null,
    promotion_type: normalizePromotionType(
      payload.promotion_type || payload.type || payload.promotion?.type,
    ),
    offer_id: String(payload.offer_id || payload.id || "").trim() || null,
    candidate_id:
      String(payload.candidate_id || payload.candidate?.id || "").trim() || null,
    offer_status: String(payload.status || "").trim() || null,
    candidate_status:
      String(payload.candidate_status || payload.candidate?.status || "").trim() || null,
    source_topic: String(meta.source_topic || "public_offers"),
    source_resource: String(meta.source_resource || "").trim() || null,
    payload_json: payload && typeof payload === "object" ? payload : {},
  };
}

function normalizeCandidatePayload(payload = {}, meta = {}) {
  return {
    meli_conta_id: toNum(meta.meli_conta_id),
    meli_user_id: toNum(meta.meli_user_id),
    item_id: String(
      payload.item_id || payload.item?.id || payload.itemId || "",
    ).trim() || null,
    promotion_id: String(
      payload.promotion_id || payload.promotion?.id || payload.promotionId || "",
    ).trim() || null,
    promotion_type: normalizePromotionType(
      payload.promotion_type || payload.type || payload.promotion?.type,
    ),
    offer_id: String(payload.offer_id || "").trim() || null,
    candidate_id: String(
      payload.candidate_id || payload.id || payload.candidate?.id || "",
    ).trim() || null,
    offer_status: String(payload.offer_status || "").trim() || null,
    candidate_status:
      String(payload.status || payload.candidate?.status || "").trim() || null,
    source_topic: String(meta.source_topic || "public_candidates"),
    source_resource: String(meta.source_resource || "").trim() || null,
    payload_json: payload && typeof payload === "object" ? payload : {},
  };
}

async function upsertPromoOfferRef(record = {}) {
  const hasOfferId = !!String(record.offer_id || "").trim();
  const hasCandidateId = !!String(record.candidate_id || "").trim();
  const hasItemId = !!String(record.item_id || "").trim();

  if (
    !record.meli_conta_id ||
    !record.meli_user_id ||
    !hasItemId ||
    (!hasOfferId && !hasCandidateId)
  ) {
    return { ok: false, skipped: true };
  }

  const bucketKey = itemPromotionBucketKey(record);
  const indexKey = itemPromotionIndexKey(record);
  const redis = redisClient();
  const existingRaw = await redis.get(bucketKey);
  let existing = [];
  if (existingRaw) {
    try {
      existing = JSON.parse(existingRaw);
      if (!Array.isArray(existing)) existing = [];
    } catch {
      existing = [];
    }
  }

  const stamp = nowIso();
  const normalized = {
    item_id: String(record.item_id || "").trim().toUpperCase() || null,
    promotion_id: record.promotion_id || null,
    promotion_type: record.promotion_type || null,
    offer_id: record.offer_id || null,
    candidate_id: record.candidate_id || null,
    offer_status: record.offer_status || null,
    candidate_status: record.candidate_status || null,
    source_topic: record.source_topic || null,
    source_resource: record.source_resource || null,
    payload_json: record.payload_json || {},
    meli_conta_id: record.meli_conta_id,
    meli_user_id: record.meli_user_id,
    last_seen_at: stamp,
    first_seen_at: stamp,
  };

  let merged = false;
  existing = existing.map((row) => {
    const sameOffer =
      normalized.offer_id &&
      row?.offer_id &&
      String(normalized.offer_id) === String(row.offer_id);
    const sameCandidate =
      normalized.candidate_id &&
      row?.candidate_id &&
      String(normalized.candidate_id) === String(row.candidate_id);
    if (!sameOffer && !sameCandidate) return row;
    merged = true;
    return {
      ...row,
      ...normalized,
      first_seen_at: row?.first_seen_at || normalized.first_seen_at,
      last_seen_at: stamp,
    };
  });

  if (!merged) existing.unshift(normalized);

  existing = existing
    .sort((a, b) => Date.parse(b?.last_seen_at || 0) - Date.parse(a?.last_seen_at || 0))
    .slice(0, Math.max(1, OFFER_REF_MAX_PER_BUCKET));

  const ttl = Math.max(300, OFFER_REF_TTL_SECONDS);
  await redis.set(bucketKey, JSON.stringify(existing), "EX", ttl);
  await redis.sadd(indexKey, bucketPromotionToken(record.promotion_id));
  await redis.expire(indexKey, ttl);

  return { ok: true, mode: merged ? "update" : "insert", key: bucketKey };
}

async function fetchResourcePayload(resource, mlCreds) {
  const url = buildMlUrl(resource);
  if (!url) return null;
  const response = await authFetch(url, mlCreds, {});
  const text = await response.text().catch(() => "");
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function ingestForAccount(account, notification = {}) {
  const topic = String(notification.topic || "").trim().toLowerCase();
  const resource = String(notification.resource || "").trim();
  if (!resource) {
    return { ok: false, skipped: true, reason: "resource_missing" };
  }

  if (!["public_offers", "public_candidates"].includes(topic)) {
    return { ok: false, skipped: true, reason: "topic_not_supported" };
  }

  const payload = await fetchResourcePayload(resource, account);
  const normalized =
    topic === "public_offers"
      ? normalizeOfferPayload(payload, {
          meli_conta_id: account.meli_conta_id,
          meli_user_id: account.meli_user_id,
          source_topic: topic,
          source_resource: resource,
        })
      : normalizeCandidatePayload(payload, {
          meli_conta_id: account.meli_conta_id,
          meli_user_id: account.meli_user_id,
          source_topic: topic,
          source_resource: resource,
        });

  const stored = await upsertPromoOfferRef(normalized);
  return {
    ok: true,
    topic,
    resource,
    meli_conta_id: account.meli_conta_id,
    stored,
    normalized,
  };
}

async function consumeNotification(notification = {}) {
  const topic = String(notification.topic || "").trim().toLowerCase();
  const meliUserId = toNum(notification.user_id);
  if (!topic || !meliUserId) {
    return {
      ok: false,
      error: "topic e user_id são obrigatórios.",
    };
  }

  const accounts = await listAccountsForMeliUser(meliUserId);
  if (!accounts.length) {
    return {
      ok: true,
      skipped: true,
      reason: "account_not_found",
      topic,
      user_id: meliUserId,
    };
  }

  const results = [];
  for (const account of accounts) {
    try {
      const result = await ingestForAccount(account, notification);
      results.push(result);
    } catch (error) {
      results.push({
        ok: false,
        topic,
        meli_conta_id: account.meli_conta_id,
        error: error?.message || String(error),
        status: error?.status || null,
        payload: error?.payload || null,
      });
    }
  }

  return {
    ok: true,
    topic,
    user_id: meliUserId,
    results,
  };
}

async function findOfferRefs({
  meliContaId,
  itemId,
  promotionId = null,
  promotionType = null,
  candidateId = null,
  limit = 10,
} = {}) {
  const contaId = toNum(meliContaId);
  const mlb = String(itemId || "").trim().toUpperCase();
  const promotion_id = String(promotionId || "").trim() || null;
  const promotion_type = normalizePromotionType(promotionType);
  const candidate_id = String(candidateId || "").trim() || null;
  const max = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 10;

  if (!contaId || !mlb) return [];

  const redis = redisClient();
  const promotionTokens = [];
  if (promotion_id) {
    promotionTokens.push(bucketPromotionToken(promotion_id));
  } else {
    const indexKey = itemPromotionIndexKey({ meli_conta_id: contaId, item_id: mlb });
    const listed = await redis.smembers(indexKey).catch(() => []);
    promotionTokens.push(...(Array.isArray(listed) ? listed : []));
  }

  const uniqueTokens = [...new Set(promotionTokens.filter(Boolean))];
  if (!uniqueTokens.length) return [];

  const bucketKeys = uniqueTokens.map((token) =>
    itemPromotionBucketKey({
      meli_conta_id: contaId,
      item_id: mlb,
      promotion_id: token === "__none__" ? null : token,
    }),
  );

  const blobs = await redis.mget(bucketKeys).catch(() => []);
  const rows = [];
  for (const blob of Array.isArray(blobs) ? blobs : []) {
    if (!blob) continue;
    try {
      const parsed = JSON.parse(blob);
      if (Array.isArray(parsed)) rows.push(...parsed);
    } catch {}
  }

  return rows
    .filter((row) => {
      if (!row || String(row.item_id || "").toUpperCase() !== mlb) return false;
      if (promotion_id && String(row.promotion_id || "") !== promotion_id) return false;
      if (
        promotion_type &&
        String(row.promotion_type || "").toUpperCase() !== promotion_type
      ) {
        return false;
      }
      if (
        candidate_id &&
        String(row.candidate_id || "") !== candidate_id &&
        String(row.offer_id || "") !== candidate_id
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      const aHasOffer = a?.offer_id ? 0 : 1;
      const bHasOffer = b?.offer_id ? 0 : 1;
      if (aHasOffer !== bHasOffer) return aHasOffer - bHasOffer;
      return Date.parse(b?.last_seen_at || 0) - Date.parse(a?.last_seen_at || 0);
    })
    .slice(0, max);
}

module.exports = {
  consumeNotification,
  findOfferRefs,
};
