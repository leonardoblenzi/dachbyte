"use strict";

const crypto = require("node:crypto");

function text(value) {
  return String(value == null ? "" : value).trim();
}

function createOAuthState() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashOAuthState(value) {
  return crypto.createHash("sha256").update(text(value), "utf8").digest("hex");
}

function safeRedirectAfter(value) {
  const raw = text(value);
  if (!raw) return "/magalu/contas";
  if (!raw.startsWith("/magalu")) return "/magalu/contas";
  if (raw.startsWith("//") || raw.includes("\\") || /[\r\n]/.test(raw)) return "/magalu/contas";
  try {
    const parsed = new URL(raw, "https://dachbyte.invalid");
    if (parsed.origin !== "https://dachbyte.invalid") return "/magalu/contas";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch (_error) {
    return "/magalu/contas";
  }
}

function decodeJwtPayload(token) {
  const parts = text(token).split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? payload : null;
  } catch (_error) {
    return null;
  }
}

function extractTenantSubject(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  const subject = text(payload?.sub);
  if (!subject || subject.length > 240) {
    const error = new Error("O access token Magalu não informou o tenant no claim sub.");
    error.code = "MAGALU_TOKEN_SUBJECT_MISSING";
    error.status = 502;
    throw error;
  }
  return { subject, payload };
}

function parseScopes(value) {
  const source = Array.isArray(value) ? value : text(value).split(/\s+/);
  return Array.from(new Set(source.map(text).filter(Boolean)));
}

function unixDate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date;
}

function resolveAccessExpiry(tokenResponse, accessToken) {
  const claims = decodeJwtPayload(accessToken);
  const jwtExpiry = unixDate(claims?.exp);
  if (jwtExpiry) return jwtExpiry;
  const created = unixDate(tokenResponse?.created_at) || new Date();
  const expiresIn = Number(tokenResponse?.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  return new Date(created.getTime() + expiresIn * 1000);
}

function resolveRefreshExpiry(refreshToken) {
  return unixDate(decodeJwtPayload(refreshToken)?.exp);
}

function secureEqual(left, right) {
  const a = Buffer.from(text(left));
  const b = Buffer.from(text(right));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  createOAuthState,
  hashOAuthState,
  safeRedirectAfter,
  decodeJwtPayload,
  extractTenantSubject,
  parseScopes,
  resolveAccessExpiry,
  resolveRefreshExpiry,
  secureEqual,
};
