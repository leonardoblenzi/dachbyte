"use strict";

const responseCache = new Map();
const inFlight = new Map();

function now() {
  return Date.now();
}

function readCache(key) {
  const entry = responseCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now()) {
    responseCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function writeCache(key, value, ttlMs) {
  const ttl = Math.max(1000, Number(ttlMs || 60000));
  responseCache.set(key, {
    value,
    expiresAt: now() + ttl,
  });
}

async function getOrSetCached(key, ttlMs, resolver) {
  const cached = readCache(key);
  if (cached !== undefined) return cached;

  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  const pending = Promise.resolve()
    .then(() => resolver())
    .then((value) => {
      writeCache(key, value, ttlMs);
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, pending);
  return pending;
}

function invalidateByPrefix(prefix) {
  const normalized = String(prefix || "");
  if (!normalized) return;

  for (const key of responseCache.keys()) {
    if (String(key).startsWith(normalized)) {
      responseCache.delete(key);
    }
  }

  for (const key of inFlight.keys()) {
    if (String(key).startsWith(normalized)) {
      inFlight.delete(key);
    }
  }
}

function clearAllCache() {
  responseCache.clear();
  inFlight.clear();
}

module.exports = {
  clearAllCache,
  getOrSetCached,
  invalidateByPrefix,
};
