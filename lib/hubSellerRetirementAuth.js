"use strict";

const { timingSafeEqual } = require("node:crypto");

function authorizedRetirementCall(header, configuredSecret) {
  const secret = String(configuredSecret || "").trim();
  const auth = String(header || "");
  if (!secret || !auth.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(auth.slice(7), "utf8");
  const expected = Buffer.from(secret, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

module.exports = { authorizedRetirementCall };
