"use strict";
const env = require("../config/env");
const lanes = new Map();
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function limitFor(kind) {
  if (kind === "sku-read") return env.MAGALU_RATE_LIMIT_SKU_READ_PER_MINUTE;
  if (kind === "sku-write") return env.MAGALU_RATE_LIMIT_SKU_WRITE_PER_MINUTE;
  if (kind === "price-read") return env.MAGALU_RATE_LIMIT_PRICE_READ_PER_MINUTE;
  if (kind === "stock-read") return env.MAGALU_RATE_LIMIT_STOCK_READ_PER_MINUTE;
  if (kind === "price-write") return env.MAGALU_RATE_LIMIT_PRICE_WRITE_PER_MINUTE;
  if (kind === "stock-write") return env.MAGALU_RATE_LIMIT_STOCK_WRITE_PER_MINUTE;
  return 300;
}
async function waitFor(accountId, kind) {
  const perMinute = Math.max(1, Number(limitFor(kind) || 1));
  const intervalMs = Math.ceil(60_000 / perMinute);
  const key = `${Number(accountId)}:${kind}`;
  const previous = lanes.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  lanes.set(key, previous.then(() => gate).catch(() => gate));
  await previous.catch(() => {});
  const stateKey = `${key}:next`;
  const nextAt = Number(lanes.get(stateKey) || 0);
  const delay = Math.max(0, nextAt - Date.now());
  if (delay > 0) await sleep(delay);
  lanes.set(stateKey, Date.now() + intervalMs);
  release();
}
function reset() { lanes.clear(); }
module.exports = { waitFor, _test: { limitFor, reset } };
