"use strict";

const DEFAULT_TTL_MS = Math.max(
  300000,
  Number(process.env.PROMO_SMART_CHECKPOINT_TTL_MS || 86400000),
);

function segment(value) {
  return encodeURIComponent(String(value || "unknown"));
}

function key(accountKey, analysisId, campaignId) {
  return `promo:smart-scan:${segment(accountKey)}:${segment(analysisId)}:${segment(campaignId)}`;
}

function manifestKey(accountKey, analysisId) {
  return `promo:smart-scan:${segment(accountKey)}:${segment(analysisId)}:manifest`;
}

function ttlOf(scope = {}) {
  return Math.max(300000, Number(scope.ttlMs || DEFAULT_TTL_MS));
}

async function save(redis, scope = {}, checkpoint = {}) {
  if (!redis) return false;
  await redis.set(
    key(scope.accountKey, scope.analysisId, scope.campaignId),
    JSON.stringify(checkpoint),
    "PX",
    ttlOf(scope),
  );
  return true;
}

async function load(redis, scope = {}) {
  if (!redis) return null;
  const raw = await redis.get(key(scope.accountKey, scope.analysisId, scope.campaignId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function remove(redis, scope = {}) {
  if (!redis) return false;
  return Number(await redis.del(key(scope.accountKey, scope.analysisId, scope.campaignId))) > 0;
}

async function addToManifest(redis, scope = {}, campaignId) {
  if (!redis || !campaignId) return false;
  const manifest = manifestKey(scope.accountKey, scope.analysisId);
  await redis.sadd(manifest, String(campaignId));
  await redis.pexpire(manifest, ttlOf(scope));
  return true;
}

async function listManifest(redis, scope = {}) {
  if (!redis) return [];
  const rows = await redis.smembers(manifestKey(scope.accountKey, scope.analysisId));
  return [...new Set((Array.isArray(rows) ? rows : []).map(String))].sort();
}

module.exports = {
  DEFAULT_TTL_MS,
  key,
  manifestKey,
  save,
  load,
  remove,
  addToManifest,
  listManifest,
};
