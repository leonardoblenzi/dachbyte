"use strict";

const SENSITIVE_KEY = /(access.?token|refresh.?token|(?:^|[_-])token(?:$|[_-])|client.?secret|secret(?:_ciphertext)?|authorization|cookie|password|passwd|pkce|jwt|api.?key|bearer)/i;
const JWT_LIKE = /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g;
const BEARER_LIKE = /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi;
const MAX_DEPTH = 7;
const MAX_KEYS = 120;
const MAX_ARRAY = 120;
const MAX_STRING = 4000;

function cleanString(value) {
  return String(value == null ? "" : value)
    .replace(BEARER_LIKE, "Bearer [REDACTED]")
    .replace(JWT_LIKE, "[REDACTED_JWT]")
    .slice(0, MAX_STRING);
}

function sanitizeAuditDetails(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return cleanString(value);
  if (typeof value !== "object") return cleanString(value);
  if (depth >= MAX_DEPTH) return "[TRUNCATED_DEPTH]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => sanitizeAuditDetails(item, depth + 1, seen));
  }

  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
    if (SENSITIVE_KEY.test(String(key))) output[key] = "[REDACTED]";
    else output[key] = sanitizeAuditDetails(item, depth + 1, seen);
  }
  return output;
}

function eventKey(action) {
  return String(action || "event")
    .trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "event";
}

function inferCategory(action, explicit = null) {
  if (explicit) return String(explicit).trim().toLowerCase();
  const upper = String(action || "").toUpperCase();
  if (upper.startsWith("MASTER_")) return "admin";
  if (upper.startsWith("WRITE_")) return "write";
  if (upper.startsWith("ACCOUNT_")) return "account";
  if (upper.includes("OAUTH")) return "oauth";
  if (upper.includes("WEBHOOK")) return "webhook";
  if (upper.includes("SYNC")) return "sync";
  return "normal";
}

function inferOutcome(action, explicit = null) {
  if (explicit) return String(explicit).trim().toLowerCase();
  const upper = String(action || "").toUpperCase();
  if (upper.includes("UNCERTAIN")) return "uncertain";
  if (upper.includes("DIVERGENT")) return "divergent";
  if (upper.includes("FAILED") || upper.includes("DENIED") || upper.includes("ERROR")) return "failure";
  if (upper.includes("STALE")) return "stale";
  if (upper.includes("SUCCEEDED") || upper.includes("SUCCESS") || upper.includes("VERIFIED") || upper.includes("ACCEPTED") || upper.includes("COMPLETED")) return "success";
  return "info";
}

function inferSeverity(action, outcome, explicit = null) {
  if (explicit) return String(explicit).trim().toLowerCase();
  const normalized = String(outcome || "").toLowerCase();
  if (normalized === "failure") return "error";
  if (["uncertain", "divergent", "stale"].includes(normalized)) return "warning";
  if (String(action || "").toUpperCase().includes("CRITICAL")) return "critical";
  return "info";
}

function normalizeAuditEvent(event = {}) {
  const action = String(event.action || event.eventKey || "EVENT").trim().slice(0, 160) || "EVENT";
  const outcome = inferOutcome(action, event.outcome);
  return {
    action,
    eventKey: String(event.eventKey || eventKey(action)).trim().slice(0, 160),
    category: inferCategory(action, event.category).slice(0, 80),
    severity: inferSeverity(action, outcome, event.severity).slice(0, 40),
    outcome: outcome.slice(0, 40),
    accountId: event.accountId ? Number(event.accountId) : null,
    operationId: event.operationId ? Number(event.operationId) : null,
    dachTenantId: String(event.dachTenantId || "").trim().slice(0, 200) || null,
    dachUserId: String(event.dachUserId || "").trim().slice(0, 200) || null,
    magaluTenantId: String(event.magaluTenantId || "").trim().slice(0, 200) || null,
    resourceType: String(event.resourceType || "").trim().slice(0, 80) || null,
    sku: String(event.sku || "").trim().slice(0, 300) || null,
    batchId: String(event.batchId || "").trim().slice(0, 300) || null,
    requestId: String(event.requestId || "").trim().slice(0, 300) || null,
    source: String(event.source || "seller-magalu").trim().slice(0, 120) || "seller-magalu",
    details: sanitizeAuditDetails(event.details || {}),
  };
}

module.exports = {
  sanitizeAuditDetails,
  normalizeAuditEvent,
  _test: { SENSITIVE_KEY, cleanString, eventKey, inferCategory, inferOutcome, inferSeverity },
};
