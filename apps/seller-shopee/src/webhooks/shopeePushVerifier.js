"use strict";

const crypto = require("crypto");

function verifyShopeePush(_req) {
  const secret = String(process.env.SHOPEE_PUSH_WEBHOOK_SECRET || "").trim();
  const requireSignature =
    String(process.env.SHOPEE_PUSH_REQUIRE_SIGNATURE || "false")
      .trim()
      .toLowerCase() === "true";
  if (!secret) {
    return { ok: true, skipped: true };
  }

  const received = String(
    _req.get("x-shopee-signature") ||
      _req.get("x-shopee-sign") ||
      "",
  ).trim();

  if (!received) {
    if (!requireSignature) {
      return { ok: true, skipped: true, reason: "missing_signature_bypassed" };
    }
    return { ok: false, reason: "missing_signature" };
  }

  const bodyString = JSON.stringify(_req.body || {});
  const expected = crypto
    .createHmac("sha256", secret)
    .update(bodyString)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  if (expectedBuffer.length !== receivedBuffer.length) {
    return { ok: false, reason: "invalid_signature" };
  }

  const valid = crypto.timingSafeEqual(expectedBuffer, receivedBuffer);

  return valid
    ? { ok: true, skipped: false }
    : { ok: false, reason: "invalid_signature" };
}

module.exports = {
  verifyShopeePush,
};
