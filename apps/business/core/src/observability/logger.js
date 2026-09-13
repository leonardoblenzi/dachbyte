"use strict";

const { getRequestContext } = require("./requestContext");

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const defaultLevel = process.env.NODE_TEST_CONTEXT ? "error" : (process.env.NODE_ENV === "production" ? "info" : "debug");
const configuredLevel = String(process.env.VOLT_CORE_LOG_LEVEL || defaultLevel).toLowerCase();
const minimumLevel = LEVELS[configuredLevel] || LEVELS.info;
const SECRET_KEY = /(password|passwd|secret|token|authorization|cookie|set-cookie|api[_-]?key|access[_-]?key|refresh[_-]?key|private[_-]?key)/i;

function redactString(value) {
  return String(value)
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:token|access_token|refresh_token|api_key|apikey|secret|password)=)[^&#\s]+/gi, "$1[REDACTED]");
}

function clean(value, key = "", seen = new WeakSet()) {
  if (value === undefined) return undefined;
  if (SECRET_KEY.test(String(key || ""))) return "[REDACTED]";
  if (typeof value === "string") return redactString(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message || ""),
      code: value.code,
      stack: redactString(value.stack || ""),
    };
  }
  if (Array.isArray(value)) return value.map((item) => clean(item, "", seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const result = {};
    for (const [childKey, child] of Object.entries(value)) {
      const cleaned = clean(child, childKey, seen);
      if (cleaned !== undefined) result[childKey] = cleaned;
    }
    seen.delete(value);
    return result;
  }
  return value;
}

function write(level, event, fields = {}) {
  if ((LEVELS[level] || LEVELS.info) < minimumLevel) return;
  const context = getRequestContext();
  const entry = clean({
    ts: new Date().toISOString(),
    level,
    service: "volt-core",
    event,
    requestId: fields.requestId || context.requestId || undefined,
    companyId: fields.companyId || context.companyId || undefined,
    userId: fields.userId || context.userId || undefined,
    ...fields,
  });
  const serialized = JSON.stringify(entry);
  if (level === "error") console.error(serialized);
  else if (level === "warn") console.warn(serialized);
  else console.log(serialized);
}

module.exports = {
  debug: (event, fields) => write("debug", event, fields),
  error: (event, fields) => write("error", event, fields),
  info: (event, fields) => write("info", event, fields),
  warn: (event, fields) => write("warn", event, fields),
  redactString,
};
