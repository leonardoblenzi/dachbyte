"use strict";

const rateLimit = require("express-rate-limit");

const STRONG_PASSWORD_MIN_LENGTH = Math.max(
  8,
  Number(process.env.ML_PASSWORD_MIN_LENGTH || 10) || 10,
);

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeOrigin(origin) {
  try {
    return new URL(String(origin || "").trim()).origin;
  } catch {
    return null;
  }
}

function isBrowserExtensionOrigin(origin) {
  return /^chrome-extension:\/\/[a-z0-9]+$/i.test(String(origin || ""));
}

function isMarketplaceOrigin(origin) {
  try {
    const host = new URL(String(origin || "")).hostname.toLowerCase();
    return (
      host === "mercadolivre.com.br" ||
      host.endsWith(".mercadolivre.com.br") ||
      host === "mercadolibre.com" ||
      host.endsWith(".mercadolibre.com") ||
      host === "shopee.com.br" ||
      host.endsWith(".shopee.com.br")
    );
  } catch {
    return false;
  }
}

function isExtensionAllowedApiPath(path) {
  const p = String(path || "");
  return p === "/api/extension" ||
    p.startsWith("/api/extension/") ||
    p === "/ml/api/extension" ||
    p.startsWith("/ml/api/extension/") ||
    p === "/api/auth/login";
}

function isProduction() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function buildAllowedExtensionOrigins() {
  return splitCsv(
    process.env.ML_EXTENSION_ALLOWED_ORIGINS ||
      process.env.APP_EXTENSION_ALLOWED_ORIGINS,
  )
    .map(normalizeOrigin)
    .filter(Boolean);
}

function allowUnregisteredExtensionOrigins() {
  const raw = process.env.ML_ALLOW_UNREGISTERED_EXTENSION_ORIGINS;
  if (raw != null) return String(raw).trim().toLowerCase() === "true";
  return !isProduction();
}

function isAllowedBrowserExtensionRequest(origin, path) {
  if (!isBrowserExtensionOrigin(origin) || !isExtensionAllowedApiPath(path)) {
    return false;
  }

  const allowedExtensionOrigins = buildAllowedExtensionOrigins();
  if (allowedExtensionOrigins.length) {
    return allowedExtensionOrigins.includes(origin);
  }

  return allowUnregisteredExtensionOrigins();
}

function isAllowedMarketplaceExtensionRequest(origin, path) {
  return isMarketplaceOrigin(origin) && isExtensionAllowedApiPath(path);
}

function getRequestOrigin(req) {
  const proto = String(req.headers?.["x-forwarded-proto"] || req.protocol || "https")
    .split(",")[0]
    .trim() || "https";
  const host = String(req.headers?.["x-forwarded-host"] || req.headers?.host || "")
    .split(",")[0]
    .trim();
  if (!host) return null;
  return `${proto}://${host}`;
}

function buildAllowedOrigins(req = null) {
  const configured = splitCsv(
    process.env.ML_ALLOWED_ORIGINS ||
      process.env.APP_ALLOWED_ORIGINS ||
      process.env.CORS_ALLOWED_ORIGINS,
  )
    .map(normalizeOrigin)
    .filter(Boolean);

  const requestOrigin = req ? normalizeOrigin(getRequestOrigin(req)) : null;
  if (requestOrigin && !configured.includes(requestOrigin)) {
    configured.push(requestOrigin);
  }

  return configured;
}

function corsOptionsDelegate(req, callback) {
  const origin = normalizeOrigin(req.headers?.origin || null);
  const allowedOrigins = buildAllowedOrigins(req);

  if (!origin) {
    return callback(null, {
      origin: false,
      credentials: true,
    });
  }

  const path = String(req.path || req.originalUrl || "");
  const isAllowed =
    allowedOrigins.includes(origin) ||
    isAllowedBrowserExtensionRequest(origin, path) ||
    isAllowedMarketplaceExtensionRequest(origin, path);
  return callback(null, {
    origin: isAllowed ? origin : false,
    credentials: true,
  });
}

function wantsHtml(req) {
  const accept = String(req.headers?.accept || "").toLowerCase();
  return (
    accept.includes("text/html") || accept.includes("application/xhtml+xml")
  );
}

function createOriginGuard(options = {}) {
  const {
    methods = ["POST", "PUT", "PATCH", "DELETE"],
    allowPrefixes = [],
    label = "requisição protegida",
  } = options;

  const normalizedMethods = new Set(methods.map((method) => String(method).toUpperCase()));
  const normalizedPrefixes = allowPrefixes.map((prefix) => String(prefix || "").trim()).filter(Boolean);

  return function originGuard(req, res, next) {
    if (!normalizedMethods.has(String(req.method || "").toUpperCase())) {
      return next();
    }

    const path = String(req.path || req.originalUrl || "");
    if (normalizedPrefixes.some((prefix) => path === prefix || path.startsWith(prefix + "/"))) {
      return next();
    }

    const origin = normalizeOrigin(req.headers?.origin || null);
    const referer = normalizeOrigin(req.headers?.referer || null);
    const allowedOrigins = buildAllowedOrigins(req);

    if (!origin && !referer) return next();

    const candidate = origin || referer;
    if (
      candidate &&
      (allowedOrigins.includes(candidate) ||
        isAllowedBrowserExtensionRequest(candidate, path) ||
        isAllowedMarketplaceExtensionRequest(candidate, path))
    ) {
      return next();
    }

    if (wantsHtml(req)) {
      return res.status(403).send(`Origem não permitida para ${label}.`);
    }

    return res.status(403).json({
      ok: false,
      error: `Origem não permitida para ${label}.`,
    });
  };
}

function createLimiter({
  windowMs,
  max,
  message,
  skipSuccessfulRequests = false,
  standardHeaders = "draft-7",
  legacyHeaders = false,
} = {}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders,
    legacyHeaders,
    skipSuccessfulRequests,
    message: {
      ok: false,
      error: message || "Muitas requisições. Tente novamente em instantes.",
    },
  });
}

const authRateLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.ML_AUTH_RATE_LIMIT_MAX || 12) || 12,
  skipSuccessfulRequests: true,
  message: "Muitas tentativas de autenticação. Aguarde alguns minutos.",
});

const oauthRateLimiter = createLimiter({
  windowMs: 10 * 60 * 1000,
  max: Number(process.env.ML_OAUTH_RATE_LIMIT_MAX || 20) || 20,
  message: "Muitas operações de OAuth. Aguarde e tente novamente.",
});

const adminWriteRateLimiter = createLimiter({
  windowMs: 5 * 60 * 1000,
  max: Number(process.env.ML_ADMIN_RATE_LIMIT_MAX || 60) || 60,
  message: "Muitas alterações administrativas em sequência. Aguarde um instante.",
});

function validateStrongPassword(password) {
  const value = String(password || "");
  if (value.length < STRONG_PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      error: `A senha deve ter no mínimo ${STRONG_PASSWORD_MIN_LENGTH} caracteres.`,
    };
  }

  const checks = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /\d/.test(value),
  ];

  if (checks.filter(Boolean).length < 3) {
    return {
      ok: false,
      error:
        "A senha deve incluir letras maiúsculas, minúsculas e números.",
    };
  }

  return { ok: true };
}

module.exports = {
  STRONG_PASSWORD_MIN_LENGTH,
  adminWriteRateLimiter,
  authRateLimiter,
  buildAllowedOrigins,
  corsOptionsDelegate,
  createOriginGuard,
  oauthRateLimiter,
  validateStrongPassword,
};
