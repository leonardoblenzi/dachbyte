"use strict";

const metrics = require("../observability/metrics");
const logger = require("../observability/logger");
const { runWithRequestContext } = require("../observability/requestContext");

function httpLogMode(environment = process.env) {
  const fallback = String(environment.NODE_ENV || "").toLowerCase() === "production" ? "slow-errors" : "all";
  const mode = String(environment.VOLT_CORE_HTTP_LOG_MODE || fallback).trim().toLowerCase();
  return ["all", "slow-errors", "errors", "off"].includes(mode) ? mode : fallback;
}

function resolveHttpLogAction({ mode, statusCode, durationMs, threshold, isApi }) {
  if (mode === "off") return null;
  if (statusCode >= 500) return "error";
  if (mode !== "errors" && durationMs >= threshold) return "warn";
  if (mode === "all" && isApi) return "info";
  return null;
}

function requestObservability(req, res, next) {
  const started = process.hrtime.bigint();
  const threshold = Number(process.env.VOLT_CORE_SLOW_REQUEST_MS || 1000);
  return runWithRequestContext({ requestId: req.id }, () => {
    res.once("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const statusCode = Number(res.statusCode || 0);
      metrics.recordRequest(statusCode, durationMs, threshold);
      const fields = {
        method: req.method,
        path: String(req.originalUrl || req.url || "").split("?")[0],
        statusCode,
        durationMs: Number(durationMs.toFixed(2)),
        companyId: req.params?.companyId,
        userId: req.user?.uid || req.user?.id,
      };
      const action = resolveHttpLogAction({
        mode: httpLogMode(),
        statusCode,
        durationMs,
        threshold,
        isApi: String(req.originalUrl || "").startsWith("/api/") || req.path === "/health",
      });
      if (action === "error") logger.error("http.request", fields);
      else if (action === "warn") logger.warn("http.request.slow", fields);
      else if (action === "info") logger.info("http.request", fields);
    });
    next();
  });
}

module.exports = requestObservability;
module.exports.httpLogMode = httpLogMode;
module.exports.resolveHttpLogAction = resolveHttpLogAction;
