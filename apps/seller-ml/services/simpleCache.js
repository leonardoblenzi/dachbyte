"use strict";

const store = new Map();

function now() {
  return Date.now();
}

function get(key) {
  const v = store.get(key);
  if (!v) return null;
  if (v.expiresAt && v.expiresAt < now()) {
    store.delete(key);
    return null;
  }
  return v.value;
}

function set(key, value, ttlSec) {
  const expiresAt = ttlSec ? now() + ttlSec * 1000 : null;
  store.set(key, { value, expiresAt });
}

module.exports = { get, set };
