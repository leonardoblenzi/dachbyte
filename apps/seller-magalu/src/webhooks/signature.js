"use strict";

const crypto = require("node:crypto");

function parseSignatureHeader(header) {
  return String(header || "")
    .split(",")
    .map((part) => part.trim().replace(/^sha256=/i, ""))
    .filter((value) => /^[0-9a-f]{64}$/i.test(value));
}

function isTimestampFresh(timestamp, maxSkewSeconds = 300, nowMs = Date.now()) {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  const delta = Math.abs(Math.floor(nowMs / 1000) - seconds);
  return delta <= Math.max(1, Number(maxSkewSeconds) || 300);
}

function expectedDigest(rawBody, timestamp, secret) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || "");
  return crypto
    .createHmac("sha256", String(secret || ""))
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), body]))
    .digest("hex");
}

function timingSafeHexEqual(left, right) {
  if (!/^[0-9a-f]{64}$/i.test(String(left || "")) || !/^[0-9a-f]{64}$/i.test(String(right || ""))) return false;
  const a = Buffer.from(String(left), "hex");
  const b = Buffer.from(String(right), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifySignature({ rawBody, signatureHeader, timestamp, secrets = [] }) {
  const signatures = parseSignatureHeader(signatureHeader);
  if (!signatures.length || !timestamp || !Array.isArray(secrets) || !secrets.length) return false;
  for (const secret of secrets) {
    const expected = expectedDigest(rawBody, timestamp, secret);
    if (signatures.some((signature) => timingSafeHexEqual(signature, expected))) return true;
  }
  return false;
}

function eventHash({ rawBody, timestamp, tenantId, topic }) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || "");
  return crypto
    .createHash("sha256")
    .update(String(timestamp || ""))
    .update("\n")
    .update(String(tenantId || ""))
    .update("\n")
    .update(String(topic || ""))
    .update("\n")
    .update(body)
    .digest("hex");
}

module.exports = {
  parseSignatureHeader,
  isTimestampFresh,
  expectedDigest,
  verifySignature,
  eventHash,
};
