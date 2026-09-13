// services/promoSelectionStore.js
// Selecoes de promocoes compartilhadas entre web/workers via Redis.
// Mantem fallback em memoria apenas para desenvolvimento/indisponibilidade temporaria.

const crypto = require('crypto');
const { getSharedRedis } = require('../lib/redisClient');

const DEFAULT_TTL_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.PROMO_SELECTION_TTL_MS || 60 * 60 * 1000),
);
const KEY_PREFIX = 'promo:selection:';
const _selections = new Map();

function redisClient() {
  try {
    return getSharedRedis('promo-selection-store');
  } catch {
    return null;
  }
}

function redisKey(token) {
  return `${KEY_PREFIX}${String(token || '')}`;
}

function cloneArray(value) {
  return Array.isArray(value)
    ? value.map((item) => (item && typeof item === 'object' ? { ...item } : item))
    : [];
}

function buildRecord(params = {}) {
  const {
    accountKey,
    promotionId,
    promotionType,
    promotionName,
    filters,
    items,
    ids,
    meta,
    userId,
    token: suppliedToken,
  } = params;
  const token = String(suppliedToken || crypto.randomBytes(16).toString('hex'));
  const arr = cloneArray(items);
  const idList = Array.isArray(ids) ? [...ids] : arr.map((item) => item?.id || item?.item_id || item);
  const now = Date.now();
  return {
    token,
    accountKey: accountKey || null,
    userId: userId || null,
    promotionId: String(promotionId || ''),
    promotionType: String(promotionType || ''),
    promotionName: promotionName ? String(promotionName) : null,
    filters: filters || {},
    ids: idList,
    items: arr,
    total: arr.length || idList.length,
    meta: meta || null,
    createdAt: now,
    expiresAt: now + DEFAULT_TTL_MS,
  };
}

async function createSelection(params = {}) {
  const record = buildRecord(params);
  _selections.set(record.token, record);
  const redis = redisClient();
  if (redis) {
    try {
      await redis.set(redisKey(record.token), JSON.stringify(record), 'PX', DEFAULT_TTL_MS);
    } catch (error) {
      console.warn('[PromoSelectionStore] Redis indisponivel ao salvar; usando memoria:', error?.message || error);
    }
  }
  return record;
}

async function getSelection(token, { accountKey } = {}) {
  const normalizedToken = String(token || '');
  if (!normalizedToken) return null;
  let rec = null;
  const redis = redisClient();
  if (redis) {
    try {
      const raw = await redis.get(redisKey(normalizedToken));
      if (raw) rec = JSON.parse(raw);
    } catch (error) {
      console.warn('[PromoSelectionStore] Falha ao ler Redis; tentando memoria:', error?.message || error);
    }
  }
  if (!rec) rec = _selections.get(normalizedToken) || null;
  if (!rec) return null;
  if (rec.expiresAt && rec.expiresAt < Date.now()) {
    _selections.delete(normalizedToken);
    if (redis) redis.del(redisKey(normalizedToken)).catch(() => {});
    return null;
  }
  if (accountKey && rec.accountKey && rec.accountKey !== accountKey) return null;
  return rec;
}

async function touch(token, extraMs = DEFAULT_TTL_MS) {
  const normalizedToken = String(token || '');
  if (!normalizedToken) return false;
  const ttl = Math.max(60 * 1000, Number(extraMs || DEFAULT_TTL_MS));
  const expiresAt = Date.now() + ttl;
  let touched = false;
  let rec = _selections.get(normalizedToken) || null;
  if (rec) {
    rec.expiresAt = expiresAt;
    touched = true;
  }
  const redis = redisClient();
  if (redis) {
    try {
      const key = redisKey(normalizedToken);
      const raw = await redis.get(key);
      if (raw) {
        const persisted = JSON.parse(raw);
        persisted.expiresAt = expiresAt;
        await redis.set(key, JSON.stringify(persisted), 'PX', ttl);
        rec = persisted;
        touched = true;
      }
    } catch {}
  }
  if (rec) _selections.set(normalizedToken, rec);
  return touched;
}

async function remove(token) {
  const normalizedToken = String(token || '');
  _selections.delete(normalizedToken);
  const redis = redisClient();
  if (redis) {
    try { await redis.del(redisKey(normalizedToken)); } catch {}
  }
}

function cleanupExpired() {
  const now = Date.now();
  for (const [tk, rec] of _selections.entries()) {
    if (rec.expiresAt && rec.expiresAt < now) _selections.delete(tk);
  }
}

module.exports = {
  saveSelection: createSelection,
  createSelection,
  getSelection,
  touch,
  remove,
  cleanupExpired,
};
