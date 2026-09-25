"use strict";

const auditRepository = require("../repositories/auditRepository");
const { sanitizeAuditDetails } = require("./auditSanitizer");

const MAX_STRING = 2000;

function cleanText(value, max = MAX_STRING) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function categoryFor(eventKey) {
  const key = cleanText(eventKey, 180).toLowerCase();
  if (key.startsWith("oauth_") || key.startsWith("token_")) return "auth";
  if (key.startsWith("account_")) return "account";
  if (key.startsWith("catalog_") || key.startsWith("sku_reconciled")) return "catalog";
  if (key.startsWith("webhook_")) return "webhook";
  if (key.startsWith("sku_mass_") || key.startsWith("mass_")) return "mass_operation";
  if (key.startsWith("admin_")) return "admin";
  if (key.startsWith("write_") || key.startsWith("price_") || key.startsWith("stock_")) return "write";
  if (key.startsWith("audit_")) return "audit";
  return "system";
}

function severityFor(eventKey, outcome) {
  const key = cleanText(eventKey, 180).toLowerCase();
  const result = cleanText(outcome, 40).toLowerCase();
  if (result === "failed" || key.includes("failed") || key.includes("denied")) return "error";
  if (["uncertain", "divergent", "stale", "canceled"].includes(result) || /(uncertain|divergent|stale|canceled)/.test(key)) return "warning";
  return "info";
}

function requestContext(req) {
  if (!req) return {};
  const forwarded = cleanText(req.headers?.["x-forwarded-for"], 300);
  const ip = forwarded ? forwarded.split(",")[0].trim() : cleanText(req.ip || req.socket?.remoteAddress, 160);
  return {
    dachTenantId: req.magaluIdentity?.dachTenantId || null,
    dachUserId: req.magaluIdentity?.dachUserId || null,
    actorEmailSnapshot: req.magaluIdentity?.email || null,
    ip: ip || null,
    userAgent: cleanText(req.headers?.["user-agent"], 1000) || null,
    source: "web",
  };
}

async function record(event, req = null) {
  const context = requestContext(req);
  const eventKey = cleanText(event?.eventKey || event?.action || "audit_event", 180).toLowerCase();
  const outcome = cleanText(event?.outcome || "success", 40).toLowerCase() || "success";
  return auditRepository.appendAuditEvent({
    ...context,
    ...event,
    eventKey,
    action: cleanText(event?.action || eventKey.toUpperCase(), 180),
    category: cleanText(event?.category || categoryFor(eventKey), 80),
    severity: cleanText(event?.severity || severityFor(eventKey, outcome), 40),
    outcome,
    details: sanitizeAuditDetails(event?.details || {}),
  });
}

async function recordBestEffort(event, req = null) {
  try {
    return await record(event, req);
  } catch (error) {
    console.warn("[seller-magalu:audit] event write failed", {
      event: event?.eventKey || event?.action || null,
      message: error?.message || String(error),
    });
    return null;
  }
}

function errorDetails(error) {
  return sanitizeAuditDetails({
    code: error?.code || null,
    status: Number(error?.status || 0) || null,
    request_id: error?.requestId || null,
    message: error?.message || String(error || "Erro desconhecido"),
  });
}

module.exports = {
  record,
  recordBestEffort,
  sanitizeValue: sanitizeAuditDetails,
  categoryFor,
  severityFor,
  requestContext,
  errorDetails,
  _test: { MAX_STRING },
};
