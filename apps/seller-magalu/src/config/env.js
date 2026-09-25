"use strict";

function clean(value) { return String(value == null ? "" : value).trim(); }
function int(value, fallback) { const parsed = Number.parseInt(clean(value), 10); return Number.isFinite(parsed) ? parsed : fallback; }
function bool(value, fallback = false) { const raw = clean(value).toLowerCase(); if (!raw) return fallback; if (["1","true","yes","on","enabled"].includes(raw)) return true; if (["0","false","no","off","disabled"].includes(raw)) return false; return fallback; }
function list(value, fallback = []) { const raw = clean(value); if (!raw) return [...fallback]; return raw.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean); }

const CATALOG_READ_SCOPES = [
  "open:portfolio-skus-seller:read",
  "open:portfolio-prices-seller:read",
  "open:portfolio-stocks-seller:read",
  "open:portfolio-categories-seller:read",
];
const ORDER_READ_SCOPES = [
  "open:order-order-seller:read",
  "open:order-delivery-seller:read",
];
const INVOICE_READ_SCOPES = ["open:order-invoice-seller:read"];
const INVOICE_WRITE_SCOPES = ["open:order-order-seller:write","open:order-delivery-seller:write","open:order-logistics-seller:write"];
const DELIVERY_FINISH_WRITE_SCOPES = ["open:order-delivery-seller:write"];
const DEFAULT_READ_SCOPES = Array.from(new Set([...CATALOG_READ_SCOPES, ...ORDER_READ_SCOPES, ...INVOICE_READ_SCOPES]));
const DEFAULT_WRITE_SCOPES = [
  "open:portfolio-prices-seller:write",
  "open:portfolio-stocks-seller:write",
];
const SKU_WRITE_SCOPE = "open:portfolio-skus-seller:write";

const MAGALU_WRITE_ENABLED = bool(process.env.MAGALU_WRITE_ENABLED, false);
const MAGALU_SKU_WRITE_ENABLED = bool(process.env.MAGALU_SKU_WRITE_ENABLED, false);
const MAGALU_DELIVERY_WRITE_ENABLED = bool(process.env.MAGALU_DELIVERY_WRITE_ENABLED, false);
const MAGALU_INVOICE_WRITE_ENABLED = bool(process.env.MAGALU_INVOICE_WRITE_ENABLED, false);
const CONFIGURED_OAUTH_SCOPES = list(process.env.MAGALU_OAUTH_SCOPES, DEFAULT_READ_SCOPES);
const DEFAULT_OAUTH_SCOPES = Array.from(new Set([
  ...CONFIGURED_OAUTH_SCOPES,
  ...ORDER_READ_SCOPES,
  ...INVOICE_READ_SCOPES,
  ...(MAGALU_WRITE_ENABLED ? DEFAULT_WRITE_SCOPES : []),
  ...(MAGALU_SKU_WRITE_ENABLED ? [SKU_WRITE_SCOPE] : []),
  ...(MAGALU_INVOICE_WRITE_ENABLED ? INVOICE_WRITE_SCOPES : []),
  ...(MAGALU_DELIVERY_WRITE_ENABLED ? DELIVERY_FINISH_WRITE_SCOPES : []),
]));

module.exports = {
  NODE_ENV: clean(process.env.NODE_ENV || "development"),
  MAGALU_DATABASE_URL: clean(process.env.MAGALU_DATABASE_URL || process.env.DATABASE_URL),
  REDIS_URL: clean(process.env.REDIS_URL || "redis://127.0.0.1:6379"),
  SUITE_JWT_SECRET: clean(process.env.SUITE_JWT_SECRET || process.env.JWT_SECRET || process.env.ML_JWT_SECRET),
  HUB_BASE_URL: clean(process.env.HUB_BASE_URL).replace(/\/+$/, ""),
  HUB_INTERNAL_TOKEN: clean(process.env.HUB_INTERNAL_TOKEN),
  HUB_REQUEST_TIMEOUT_MS: int(process.env.HUB_REQUEST_TIMEOUT_MS, 8000),
  MAGALU_HUB_GATE_MODE: clean(process.env.MAGALU_HUB_GATE_MODE || process.env.HUB_AUTH_MODE || "strict").toLowerCase(),
  MAGALU_ENCRYPTION_KEY: clean(process.env.MAGALU_ENCRYPTION_KEY),
  MAGALU_OAUTH_CLIENT_ID: clean(process.env.MAGALU_OAUTH_CLIENT_ID),
  MAGALU_OAUTH_CLIENT_SECRET: clean(process.env.MAGALU_OAUTH_CLIENT_SECRET),
  MAGALU_OAUTH_REDIRECT_URI: clean(process.env.MAGALU_OAUTH_REDIRECT_URI || "https://dachbyte.tech/magalu/auth/callback"),
  MAGALU_OAUTH_AUTHORIZE_URL: clean(process.env.MAGALU_OAUTH_AUTHORIZE_URL || "https://id.magalu.com/login"),
  MAGALU_OAUTH_TOKEN_URL: clean(process.env.MAGALU_OAUTH_TOKEN_URL || "https://id.magalu.com/oauth/token"),
  MAGALU_OAUTH_SCOPES: [...DEFAULT_OAUTH_SCOPES],
  MAGALU_OAUTH_STATE_TTL_SECONDS: int(process.env.MAGALU_OAUTH_STATE_TTL_SECONDS, 600),
  MAGALU_TOKEN_REFRESH_SKEW_SECONDS: int(process.env.MAGALU_TOKEN_REFRESH_SKEW_SECONDS, 900),
  MAGALU_API_BASE_URL: clean(process.env.MAGALU_API_BASE_URL || "https://api.magalu.com").replace(/\/+$/, ""),
  MAGALU_SERVICES_BASE_URL: clean(process.env.MAGALU_SERVICES_BASE_URL || "https://services.magalu.com").replace(/\/+$/, ""),
  MAGALU_WEBHOOK_MAX_SKEW_SECONDS: int(process.env.MAGALU_WEBHOOK_MAX_SKEW_SECONDS, 300),
  MAGALU_SYNC_PAGE_SIZE: Math.min(100, Math.max(1, int(process.env.MAGALU_SYNC_PAGE_SIZE, 100))),
  MAGALU_SYNC_DETAIL_CONCURRENCY: Math.min(12, Math.max(1, int(process.env.MAGALU_SYNC_DETAIL_CONCURRENCY, 6))),
  MAGALU_RATE_LIMIT_SKU_READ_PER_MINUTE: Math.max(1, int(process.env.MAGALU_RATE_LIMIT_SKU_READ_PER_MINUTE, 500)),
  MAGALU_RATE_LIMIT_ORDER_READ_PER_MINUTE: Math.min(800, Math.max(1, int(process.env.MAGALU_RATE_LIMIT_ORDER_READ_PER_MINUTE, 800))),
  MAGALU_RATE_LIMIT_DELIVERY_READ_PER_MINUTE: Math.min(800, Math.max(1, int(process.env.MAGALU_RATE_LIMIT_DELIVERY_READ_PER_MINUTE, 800))),
  MAGALU_ORDER_SYNC_PAGE_SIZE: Math.min(100, Math.max(1, int(process.env.MAGALU_ORDER_SYNC_PAGE_SIZE, 50))),
  MAGALU_ORDER_SYNC_MAX_PAGES: Math.min(100, Math.max(1, int(process.env.MAGALU_ORDER_SYNC_MAX_PAGES, 50))),
  MAGALU_ORDER_SYNC_LOOKBACK_DAYS: Math.min(365, Math.max(1, int(process.env.MAGALU_ORDER_SYNC_LOOKBACK_DAYS, 90))),
  MAGALU_RATE_LIMIT_INVOICE_READ_PER_MINUTE: Math.min(800, Math.max(1, int(process.env.MAGALU_RATE_LIMIT_INVOICE_READ_PER_MINUTE, 800))),
  MAGALU_RATE_LIMIT_DELIVERY_WRITE_PER_MINUTE: Math.min(500, Math.max(1, int(process.env.MAGALU_RATE_LIMIT_DELIVERY_WRITE_PER_MINUTE, 300))),
  MAGALU_DELIVERY_WRITE_ENABLED,
  MAGALU_INVOICE_WRITE_ENABLED,
  MAGALU_DELIVERY_WRITE_PREVIEW_TTL_SECONDS: Math.max(60, int(process.env.MAGALU_DELIVERY_WRITE_PREVIEW_TTL_SECONDS, 600)),
  MAGALU_DELIVERY_WRITE_VERIFY_ATTEMPTS: Math.min(12, Math.max(1, int(process.env.MAGALU_DELIVERY_WRITE_VERIFY_ATTEMPTS, 6))),
  MAGALU_DELIVERY_WRITE_VERIFY_DELAY_MS: Math.max(250, int(process.env.MAGALU_DELIVERY_WRITE_VERIFY_DELAY_MS, 1500)),
  MAGALU_INVOICE_XML_MAX_BYTES: Math.min(2000000, Math.max(65536, int(process.env.MAGALU_INVOICE_XML_MAX_BYTES, 1500000))),
  MAGALU_RATE_LIMIT_SKU_WRITE_PER_MINUTE: Math.min(500, Math.max(1, int(process.env.MAGALU_RATE_LIMIT_SKU_WRITE_PER_MINUTE, 500))),
  MAGALU_RATE_LIMIT_PRICE_READ_PER_MINUTE: Math.max(1, int(process.env.MAGALU_RATE_LIMIT_PRICE_READ_PER_MINUTE, 800)),
  MAGALU_RATE_LIMIT_STOCK_READ_PER_MINUTE: Math.max(1, int(process.env.MAGALU_RATE_LIMIT_STOCK_READ_PER_MINUTE, 800)),
  MAGALU_RATE_LIMIT_PRICE_WRITE_PER_MINUTE: Math.max(1, int(process.env.MAGALU_RATE_LIMIT_PRICE_WRITE_PER_MINUTE, 800)),
  MAGALU_RATE_LIMIT_STOCK_WRITE_PER_MINUTE: Math.max(1, int(process.env.MAGALU_RATE_LIMIT_STOCK_WRITE_PER_MINUTE, 600)),
  MAGALU_WRITE_ENABLED,
  MAGALU_WRITE_MAX_BATCH_SIZE: Math.min(100, Math.max(1, int(process.env.MAGALU_WRITE_MAX_BATCH_SIZE, 50))),
  MAGALU_WRITE_PREVIEW_TTL_SECONDS: Math.max(60, int(process.env.MAGALU_WRITE_PREVIEW_TTL_SECONDS, 300)),
  MAGALU_WRITE_VERIFY_ATTEMPTS: Math.min(12, Math.max(1, int(process.env.MAGALU_WRITE_VERIFY_ATTEMPTS, 6))),
  MAGALU_WRITE_VERIFY_DELAY_MS: Math.max(250, int(process.env.MAGALU_WRITE_VERIFY_DELAY_MS, 1500)),
  MAGALU_SKU_WRITE_ENABLED,
  MAGALU_SKU_UPDATE_CONCURRENCY: 6,
  MAGALU_SKU_MAX_BATCH_SIZE: Math.min(5000, Math.max(1, int(process.env.MAGALU_SKU_MAX_BATCH_SIZE, 5000))),
  MAGALU_SKU_PREVIEW_TTL_SECONDS: Math.max(60, int(process.env.MAGALU_SKU_PREVIEW_TTL_SECONDS, 600)),
  MAGALU_SKU_VERIFY_ATTEMPTS: Math.min(12, Math.max(1, int(process.env.MAGALU_SKU_VERIFY_ATTEMPTS, 6))),
  MAGALU_SKU_VERIFY_DELAY_MS: Math.max(250, int(process.env.MAGALU_SKU_VERIFY_DELAY_MS, 1500)),
  _DEFAULT_READ_SCOPES: DEFAULT_READ_SCOPES,
  _CATALOG_READ_SCOPES: CATALOG_READ_SCOPES,
  _ORDER_READ_SCOPES: ORDER_READ_SCOPES,
  _INVOICE_READ_SCOPES: INVOICE_READ_SCOPES,
  _INVOICE_WRITE_SCOPES: INVOICE_WRITE_SCOPES,
  _DELIVERY_FINISH_WRITE_SCOPES: DELIVERY_FINISH_WRITE_SCOPES,
  _DEFAULT_WRITE_SCOPES: DEFAULT_WRITE_SCOPES,
  _SKU_WRITE_SCOPE: SKU_WRITE_SCOPE,
  _DEFAULT_OAUTH_SCOPES: DEFAULT_OAUTH_SCOPES,
};
