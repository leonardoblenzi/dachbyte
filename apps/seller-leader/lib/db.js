"use strict";

const { Pool } = require("pg");

function createPool(connectionString) {
  if (!connectionString) return null;
  return new Pool({
    connectionString,
    ssl: /sslmode=require/i.test(connectionString)
      ? { rejectUnauthorized: false }
      : undefined,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

function resolveUrlWithSource(candidates = []) {
  for (const candidate of candidates) {
    const value = String(candidate?.value || "").trim();
    if (!value) continue;
    return {
      value,
      source: candidate?.key || "unknown",
    };
  }

  return {
    value: "",
    source: null,
  };
}

function resolveDbConfig() {
  const sku = resolveUrlWithSource([
    { key: "SKULEADER_DATABASE_URL", value: process.env.SKULEADER_DATABASE_URL },
    { key: "SKU_TRACKER_DATABASE_URL", value: process.env.SKU_TRACKER_DATABASE_URL },
    { key: "LEADERSKU_DATABASE_URL", value: process.env.LEADERSKU_DATABASE_URL },
    { key: "Leader_DATABASE", value: process.env.Leader_DATABASE },
    { key: "LEADER_DATABASE", value: process.env.LEADER_DATABASE },
  ]);

  const ml = resolveUrlWithSource([
    { key: "SKULEADER_ML_DATABASE_URL", value: process.env.SKULEADER_ML_DATABASE_URL },
    { key: "ML_DATABASE_URL", value: process.env.ML_DATABASE_URL },
  ]);

  const shopee = resolveUrlWithSource([
    { key: "DATABASE_URL", value: process.env.DATABASE_URL },
    { key: "SKULEADER_SHOPEE_DATABASE_URL", value: process.env.SKULEADER_SHOPEE_DATABASE_URL },
    { key: "SHOPEE_DATABASE_URL", value: process.env.SHOPEE_DATABASE_URL },
  ]);

  return {
    sku,
    ml,
    shopee,
  };
}

let skuPool = null;
let mlPool = null;
let shopeePool = null;
let skuPoolKey = "";
let mlPoolKey = "";
let shopeePoolKey = "";

function refreshPool(currentPool, currentKey, nextKey) {
  if (nextKey === currentKey) {
    return { pool: currentPool, key: currentKey };
  }

  if (currentPool) {
    currentPool.end().catch(() => {});
  }

  return {
    pool: createPool(nextKey),
    key: nextKey,
  };
}

function ensurePools() {
  const cfg = resolveDbConfig();

  const nextSku = refreshPool(skuPool, skuPoolKey, String(cfg.sku.value || ""));
  skuPool = nextSku.pool;
  skuPoolKey = nextSku.key;

  const nextMl = refreshPool(mlPool, mlPoolKey, String(cfg.ml.value || ""));
  mlPool = nextMl.pool;
  mlPoolKey = nextMl.key;

  const nextShopee = refreshPool(shopeePool, shopeePoolKey, String(cfg.shopee.value || ""));
  shopeePool = nextShopee.pool;
  shopeePoolKey = nextShopee.key;

  return cfg;
}

async function querySku(sql, params = []) {
  const cfg = ensurePools();
  if (!skuPool) {
    const err = new Error("Conexao SKU Tracker indisponivel.");
    err.details = {
      expected_env: "SKULEADER_DATABASE_URL ou SKU_TRACKER_DATABASE_URL",
      resolved_source: cfg?.sku?.source || null,
    };
    throw err;
  }
  return skuPool.query(sql, params);
}

async function queryMl(sql, params = []) {
  const cfg = ensurePools();
  if (!mlPool) {
    const err = new Error("Conexao ML indisponivel.");
    err.details = {
      expected_env: "SKULEADER_ML_DATABASE_URL ou ML_DATABASE_URL",
      resolved_source: cfg?.ml?.source || null,
    };
    throw err;
  }
  return mlPool.query(sql, params);
}

async function queryShopee(sql, params = []) {
  const cfg = ensurePools();
  if (!shopeePool) {
    const err = new Error("Conexao Shopee indisponivel.");
    err.details = {
      expected_env: "DATABASE_URL (ou SKULEADER_SHOPEE_DATABASE_URL/SHOPEE_DATABASE_URL)",
      resolved_source: cfg?.shopee?.source || null,
    };
    throw err;
  }
  return shopeePool.query(sql, params);
}

function getDbDiagnostics() {
  const cfg = ensurePools();
  return {
    sku: {
      expected_env: "SKULEADER_DATABASE_URL ou SKU_TRACKER_DATABASE_URL",
      resolved_source: cfg?.sku?.source || null,
      configured: Boolean(String(cfg?.sku?.value || "")),
      pool_ready: Boolean(skuPool),
    },
    ml: {
      expected_env: "SKULEADER_ML_DATABASE_URL ou ML_DATABASE_URL",
      resolved_source: cfg?.ml?.source || null,
      configured: Boolean(String(cfg?.ml?.value || "")),
      pool_ready: Boolean(mlPool),
    },
    shopee: {
      expected_env: "DATABASE_URL (ou SKULEADER_SHOPEE_DATABASE_URL/SHOPEE_DATABASE_URL)",
      resolved_source: cfg?.shopee?.source || null,
      configured: Boolean(String(cfg?.shopee?.value || "")),
      pool_ready: Boolean(shopeePool),
    },
  };
}

module.exports = {
  querySku,
  queryMl,
  queryShopee,
  getDbDiagnostics,
};
