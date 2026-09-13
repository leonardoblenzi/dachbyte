"use strict";

const {
  insertProcessExecutionLog,
} = require("../repositories/processExecutionSqlRepository");

const TRACKED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function truncateText(value, max = 800) {
  const text = String(value == null ? "" : value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function sanitizeJson(value, depth = 0) {
  if (value == null) return null;
  if (depth > 4) return "[max_depth]";
  if (typeof value === "string") return truncateText(value, 1200);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => sanitizeJson(item, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).slice(0, 80)) {
      if (String(key).toLowerCase().includes("password")) {
        out[key] = "***";
        continue;
      }
      out[key] = sanitizeJson(value[key], depth + 1);
    }
    return out;
  }
  return truncateText(String(value), 200);
}

function shouldTrack(req) {
  const method = String(req.method || "").toUpperCase();
  if (!TRACKED_METHODS.has(method)) return false;

  const url = String(req.originalUrl || req.url || "");
  if (!url) return false;

  if (
    url.includes("/webhooks/") ||
    url.includes("/health") ||
    url.includes("/status")
  ) {
    return false;
  }

  return true;
}

function processActionTracker() {
  return (req, res, next) => {
    if (!shouldTrack(req)) return next();

    const startedAt = Date.now();
    const requestedAt = new Date();
    let responsePayload = null;

    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    res.json = (body) => {
      responsePayload = body;
      return originalJson(body);
    };
    res.send = (body) => {
      if (responsePayload == null) responsePayload = body;
      return originalSend(body);
    };

    res.on("finish", () => {
      const finishedAt = new Date();
      const durationMs = Math.max(0, Date.now() - startedAt);
      const statusCode = Number(res.statusCode || 0);
      const success = statusCode >= 200 && statusCode < 400;
      const payload = responsePayload && typeof responsePayload === "object" ? responsePayload : {};

      const errorCode = !success
        ? String(payload?.error || payload?.code || "").trim() || null
        : null;
      const errorMessage = !success
        ? String(payload?.message || payload?.details || "").trim() || `HTTP ${statusCode}`
        : null;

      const auth = req.auth || null;
      const requestBody = req.body && typeof req.body === "object" ? sanitizeJson(req.body) : null;
      const safeResponseBody =
        responsePayload && typeof responsePayload === "object"
          ? sanitizeJson(responsePayload)
          : null;

      void insertProcessExecutionLog({
        requestedAt,
        finishedAt,
        durationMs,
        method: String(req.method || "").toUpperCase(),
        path: String(req.path || req.originalUrl || ""),
        queryString: req.originalUrl && req.originalUrl.includes("?")
          ? String(req.originalUrl.split("?")[1] || "")
          : null,
        statusCode,
        success,
        errorCode,
        errorMessage,
        requestBody,
        responseBody: safeResponseBody,
        ip: String(req.headers?.["x-forwarded-for"] || req.ip || req.socket?.remoteAddress || ""),
        userAgent: String(req.headers?.["user-agent"] || ""),
        userId: auth?.userId == null ? null : Number(auth.userId),
        userEmail: auth?.email || null,
        userRole: auth?.role || null,
        accountId: auth?.accountId == null ? null : Number(auth.accountId),
      }).catch((error) => {
        console.error("[processActionTracker] failed to persist action log", {
          path: req.path,
          method: req.method,
          error: String(error?.message || error),
        });
      });
    });

    return next();
  };
}

module.exports = processActionTracker;

