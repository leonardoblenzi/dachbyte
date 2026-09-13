"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const metrics = require("../observability/metrics");
const logger = require("../observability/logger");
const requestObservability = require("./requestObservability");
const { httpLogMode, resolveHttpLogAction } = requestObservability;

test("HTTP log mode defaults to slow-errors in production and all elsewhere", () => {
  assert.equal(httpLogMode({ NODE_ENV: "production" }), "slow-errors");
  assert.equal(httpLogMode({ NODE_ENV: "test" }), "all");
  assert.equal(httpLogMode({}), "all");
});

test("HTTP log mode accepts supported values and falls back for invalid values", () => {
  for (const mode of ["all", "slow-errors", "errors", "off"]) {
    assert.equal(httpLogMode({ NODE_ENV: "production", VOLT_CORE_HTTP_LOG_MODE: mode.toUpperCase() }), mode);
  }
  assert.equal(httpLogMode({ NODE_ENV: "production", VOLT_CORE_HTTP_LOG_MODE: "verbose" }), "slow-errors");
  assert.equal(httpLogMode({ NODE_ENV: "test", VOLT_CORE_HTTP_LOG_MODE: "verbose" }), "all");
});

test("slow-errors ignores successful fast requests and keeps slow and server errors", () => {
  assert.equal(resolveHttpLogAction({ mode: "slow-errors", statusCode: 200, durationMs: 20, threshold: 1000, isApi: true }), null);
  assert.equal(resolveHttpLogAction({ mode: "slow-errors", statusCode: 304, durationMs: 20, threshold: 1000, isApi: true }), null);
  assert.equal(resolveHttpLogAction({ mode: "slow-errors", statusCode: 200, durationMs: 1200, threshold: 1000, isApi: true }), "warn");
  assert.equal(resolveHttpLogAction({ mode: "slow-errors", statusCode: 503, durationMs: 20, threshold: 1000, isApi: true }), "error");
});

test("errors logs only server failures", () => {
  assert.equal(resolveHttpLogAction({ mode: "errors", statusCode: 200, durationMs: 1200, threshold: 1000, isApi: true }), null);
  assert.equal(resolveHttpLogAction({ mode: "errors", statusCode: 503, durationMs: 20, threshold: 1000, isApi: true }), "error");
});

test("all preserves API info access logs and off suppresses request logs", () => {
  assert.equal(resolveHttpLogAction({ mode: "all", statusCode: 200, durationMs: 20, threshold: 1000, isApi: true }), "info");
  assert.equal(resolveHttpLogAction({ mode: "all", statusCode: 200, durationMs: 20, threshold: 1000, isApi: false }), null);
  assert.equal(resolveHttpLogAction({ mode: "off", statusCode: 503, durationMs: 20, threshold: 1000, isApi: true }), null);
});

test("off suppresses request logs without suppressing request metrics", () => {
  const original = {
    mode: process.env.VOLT_CORE_HTTP_LOG_MODE,
    recordRequest: metrics.recordRequest,
    info: logger.info,
    warn: logger.warn,
    error: logger.error,
  };
  const recorded = [];
  const logs = [];
  process.env.VOLT_CORE_HTTP_LOG_MODE = "off";
  metrics.recordRequest = (...args) => recorded.push(args);
  logger.info = (...args) => logs.push(["info", ...args]);
  logger.warn = (...args) => logs.push(["warn", ...args]);
  logger.error = (...args) => logs.push(["error", ...args]);
  try {
    const response = new EventEmitter();
    response.statusCode = 503;
    const request = { id: "request-test", method: "GET", originalUrl: "/api/core/health", params: {} };
    requestObservability(request, response, () => response.emit("finish"));
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0][0], 503);
    assert.deepEqual(logs, []);
  } finally {
    if (original.mode === undefined) delete process.env.VOLT_CORE_HTTP_LOG_MODE;
    else process.env.VOLT_CORE_HTTP_LOG_MODE = original.mode;
    metrics.recordRequest = original.recordRequest;
    logger.info = original.info;
    logger.warn = original.warn;
    logger.error = original.error;
  }
});
