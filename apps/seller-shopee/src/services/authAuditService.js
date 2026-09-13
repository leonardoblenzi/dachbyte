"use strict";

const {
  cleanupAuthAuditBefore,
  insertAuthAuditEvent,
} = require("../repositories/authSqlRepository");

function retentionDays() {
  const days = Number(process.env.AUTH_AUDIT_RETENTION_DAYS || 90);
  return Number.isFinite(days) && days > 0 ? days : 90;
}

function getRequestIp(req) {
  const forwarded = String(req.headers?.["x-forwarded-for"] || "").trim();
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

function getRequestUserAgent(req) {
  return String(req.headers?.["user-agent"] || "").trim() || null;
}

async function cleanupAuthAudit() {
  const cutoff = new Date(Date.now() - retentionDays() * 24 * 60 * 60 * 1000);
  await cleanupAuthAuditBefore(cutoff);
}

async function recordAuthEvent({
  userId = null,
  email = null,
  event,
  status = "info",
  ip = null,
  userAgent = null,
  metadata = null,
}) {
  await insertAuthAuditEvent({
    userId,
    email,
    event,
    status,
    ip,
    userAgent,
    metadata,
  });
}

module.exports = {
  cleanupAuthAudit,
  getRequestIp,
  getRequestUserAgent,
  recordAuthEvent,
};
