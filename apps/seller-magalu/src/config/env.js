"use strict";

function clean(value) {
  return String(value == null ? "" : value).trim();
}

function int(value, fallback) {
  const parsed = Number.parseInt(clean(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback = false) {
  const raw = clean(value).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on", "enabled"].includes(raw)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(raw)) return false;
  return fallback;
}

function list(value, fallback = []) {
  const raw = clean(value);
  if (!raw) return [...fallback];
  return raw.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

const DEFAULT_READ_SCOPES = [
  "open:portfolio-skus-seller:read",
  "open:portfolio-prices-seller:read",
  "open:portfolio-stocks-seller:read",
  "open:portfolio-categories-seller:read",
];

const DEFAULT_WRITE_SCOPES = [
  "open:portfolio-prices-seller:write",
  "open:portfolio-stocks-seller:write",
];

const MAGALU_WRITE_ENABLED = bool(process.env.MAGALU_WRITE_ENABLED, false);
const CONFIGURED_OAUTH_SCOPES = list(process.env.MAGALU_OAUTH_SCOPES, DEFAULT_READ_SCOPES);
const DEFAULT_OAUTH_SCOPES = MAGALU_WRITE_ENABLED
  ? Array.from(new Set([...CONFIGURED_OAUTH_SCOPES, ...DEFAULT_WRITE_SCOPES]))
  : CONFIGURED_OAUTH_SCOPES;

module.exports = {
  NODE_ENV: clean(process.env.NODE_ENV || "development"),
  MAGALU_DATABASE_URL: clean(process.env.MAGALU_DATABASE_URL || process.env.DATABASE_URL),
  REDIS_URL: clean(process.env.REDIS_URL || "redis://127.0.0.1:6379"),
  SUITE_JWT_SECRET: clean(
    process.env.SUITE_JWT_SECRET || process.env.JWT_SECRET || process.env.ML_JWT_SECRET,
  ),
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
  MAGALU_RATE_LIMIT_PRICE_READ_PER_MINUTE: Math.max(1, int(process.env.MAGALU_RATE_LIMIT_PRICE_READ_PER_MINUTE, 800)),
  MAGALU_RATE_LIMIT_STOCK_READ_PER_MINUTE: Math.max(1, int(process.env.MAGALU_RATE_LIMIT_STOCK_READ_PER_MINUTE, 800)),
  MAGALU_RATE_LIMIT_PRICE_WRITE_PER_MINUTE: Math.max(1, int(process.env.MAGALU_RATE_LIMIT_PRICE_WRITE_PER_MINUTE, 800)),
  MAGALU_RATE_LIMIT_STOCK_WRITE_PER_MINUTE: Math.max(1, int(process.env.MAGALU_RATE_LIMIT_STOCK_WRITE_PER_MINUTE, 600)),
  MAGALU_WRITE_ENABLED,
  MAGALU_WRITE_MAX_BATCH_SIZE: Math.min(100, Math.max(1, int(process.env.MAGALU_WRITE_MAX_BATCH_SIZE, 50))),
  MAGALU_WRITE_PREVIEW_TTL_SECONDS: Math.max(60, int(process.env.MAGALU_WRITE_PREVIEW_TTL_SECONDS, 300)),
  MAGALU_WRITE_VERIFY_ATTEMPTS: Math.min(12, Math.max(1, int(process.env.MAGALU_WRITE_VERIFY_ATTEMPTS, 6))),
  MAGALU_WRITE_VERIFY_DELAY_MS: Math.max(250, int(process.env.MAGALU_WRITE_VERIFY_DELAY_MS, 1500)),
  _DEFAULT_READ_SCOPES: DEFAULT_READ_SCOPES,
  _DEFAULT_WRITE_SCOPES: DEFAULT_WRITE_SCOPES,
  _DEFAULT_OAUTH_SCOPES: DEFAULT_OAUTH_SCOPES,
};
