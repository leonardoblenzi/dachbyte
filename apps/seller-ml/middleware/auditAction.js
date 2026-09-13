"use strict";

const {
  getRequestIp,
  getRequestUserAgent,
  recordAuthEvent,
} = require("../services/authAuditService");

function normalizeStatusCode(statusCode) {
  const code = Number(statusCode) || 0;
  if (code >= 200 && code < 300) return "success";
  if (code >= 400 && code < 500) return "warn";
  return "error";
}

function pickActor(req) {
  return {
    userId: Number(req.user?.uid) || null,
    email: req.user?.email || null,
  };
}

function safeValue(value) {
  if (value == null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(safeValue);
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item == null) {
        out[key] = item;
        continue;
      }
      if (typeof item === "string" && item.length > 500) {
        out[key] = `${item.slice(0, 497)}...`;
        continue;
      }
      out[key] = safeValue(item);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 500) {
    return `${value.slice(0, 497)}...`;
  }
  return value;
}

function createAuditAction({
  evento,
  metadata = null,
  skip = null,
}) {
  if (!evento) throw new Error("evento is required for audit middleware.");

  return function auditActionMiddleware(req, res, next) {
    const startedAt = Date.now();
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;

      if (typeof skip === "function" && skip(req, res)) return;

      const baseMetadata =
        typeof metadata === "function" ? metadata(req, res) : metadata;

      const actor = pickActor(req);
      const payload = {
        route: req.originalUrl || req.url || null,
        method: req.method,
        params: safeValue(req.params || {}),
        query: safeValue(req.query || {}),
        accountKey: res.locals?.accountKey || null,
        accountLabel: res.locals?.accountLabel || null,
        meli_conta_id: res.locals?.mlCreds?.meli_conta_id || null,
        duration_ms: Date.now() - startedAt,
        ...(baseMetadata && typeof baseMetadata === "object"
          ? safeValue(baseMetadata)
          : {}),
      };

      recordAuthEvent({
        userId: actor.userId,
        email: actor.email,
        evento,
        status: normalizeStatusCode(res.statusCode),
        ip: getRequestIp(req),
        userAgent: getRequestUserAgent(req),
        metadata: payload,
      }).catch((err) => {
        console.error("audit action erro:", err?.message || err);
      });
    };

    res.on("finish", finish);
    res.on("close", finish);
    next();
  };
}

module.exports = {
  createAuditAction,
};
