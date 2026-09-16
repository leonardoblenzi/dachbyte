"use strict";

require("./loadEnv").loadLocalEnv();
const crypto = require("crypto");

function env(name, fallback = "") {
  return String(process.env[name] ?? fallback).trim();
}

function boolEnv(name, fallback = false) {
  const value = env(name, fallback ? "true" : "false").toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

function normalizePublicPath(value, fallback = "/business/price") {
  const raw = String(value || fallback || "").trim();
  if (!raw || raw === "/") return "";
  return `/${raw.replace(/^\/+|\/+$/g, "")}`;
}

const config = {
  nodeEnv: env("NODE_ENV", "development"),
  isProduction: env("NODE_ENV", "development").toLowerCase() === "production",
  // Runtime and migrations use separate PostgreSQL roles on the VPS.
  // Legacy variable names remain supported during rollout.
  databaseUrl: env("DB_VOLTPRICE") || env("VOLT_PRICE_DATABASE_URL") || env("DATABASE_URL"),
  directDatabaseUrl: env("DB_VOLTPRICE_DIRECT") || env("VOLT_PRICE_DIRECT_DATABASE_URL") || env("DB_VOLTPRICE") || env("VOLT_PRICE_DATABASE_URL") || env("DATABASE_URL"),
  publicBaseUrl: env("VOLT_PRICE_PUBLIC_BASE_URL"),
  publicPath: normalizePublicPath(env("VOLT_PRICE_PUBLIC_PATH"), "/business/price"),
  sessionCookie: env("VOLT_PRICE_SESSION_COOKIE", "volt_price_session"),
  sessionTtlHours: Number(env("VOLT_PRICE_SESSION_TTL_HOURS", "24")),
  encryptionKey: env("VOLT_PRICE_ENCRYPTION_KEY"),
  bootstrapMasterEnabled: boolEnv("VOLT_PRICE_BOOTSTRAP_MASTER_ENABLED", false),
  bootstrapMasterEmail: env("VOLT_PRICE_BOOTSTRAP_MASTER_EMAIL").toLowerCase(),
  bootstrapMasterPassword: env("VOLT_PRICE_BOOTSTRAP_MASTER_PASSWORD"),
  bootstrapMasterTotpSecret: env("VOLT_PRICE_BOOTSTRAP_MASTER_TOTP_SECRET"),
  tray: {
    consumerKey: env("TRAY_CONSUMER_KEY") || env("VOLT_PRICE_TRAY_CONSUMER_KEY"),
    consumerSecret: env("TRAY_CONSUMER_SECRET") || env("VOLT_PRICE_TRAY_CONSUMER_SECRET"),
  },
  meli: {
    clientId: env("MELI_CLIENT_ID") || env("VOLT_PRICE_MELI_CLIENT_ID"),
    clientSecret: env("MELI_CLIENT_SECRET") || env("VOLT_PRICE_MELI_CLIENT_SECRET"),
    authBase: env("VOLT_PRICE_MELI_AUTH_BASE", "https://auth.mercadolivre.com.br"),
    apiBase: env("VOLT_PRICE_MELI_API_BASE", "https://api.mercadolibre.com"),
  },
  shopee: {
    partnerId: env("SHOPEE_PARTNER_ID") || env("VOLT_PRICE_SHOPEE_PARTNER_ID"),
    partnerKey: env("SHOPEE_PARTNER_KEY") || env("VOLT_PRICE_SHOPEE_PARTNER_KEY"),
    apiBase: env("VOLT_PRICE_SHOPEE_API_BASE", "https://partner.shopeemobile.com"),
    authPartnerPath: env("VOLT_PRICE_SHOPEE_AUTH_PARTNER_PATH", "/api/v2/shop/auth_partner"),
    tokenPath: env("VOLT_PRICE_SHOPEE_TOKEN_PATH", "/api/v2/auth/token/get"),
    refreshPath: env("VOLT_PRICE_SHOPEE_REFRESH_PATH", "/api/v2/auth/access_token/get"),
    escrowPath: env("VOLT_PRICE_SHOPEE_ESCROW_PATH", "/api/v2/payment/get_escrow_detail"),
    orderListPath: env("VOLT_PRICE_SHOPEE_ORDER_LIST_PATH", "/api/v2/order/get_order_list"),
    orderDetailPath: env("VOLT_PRICE_SHOPEE_ORDER_DETAIL_PATH", "/api/v2/order/get_order_detail"),
  },
};

function baseUrl(req) {
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.get("host") || "").split(",")[0].trim();
  return `${proto}://${host}`;
}

function publicPath(suffix = "") {
  const tail = String(suffix || "");
  if (!tail) return config.publicPath || "/";
  return `${config.publicPath}${tail.startsWith("/") ? tail : `/${tail}`}` || "/";
}

function requestId(req) {
  return String(req.headers["x-request-id"] || crypto.randomUUID());
}

module.exports = { config, baseUrl, publicPath, requestId };
