"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("OAuth never requests the order write scope absent from the IDM client", () => {
  const previous = {
    scopes: process.env.MAGALU_OAUTH_SCOPES,
    invoice: process.env.MAGALU_INVOICE_WRITE_ENABLED,
  };
  const modulePath = require.resolve("../src/config/env");
  try {
    process.env.MAGALU_OAUTH_SCOPES = "open:portfolio-skus-seller:read open:order-order-seller:write";
    process.env.MAGALU_INVOICE_WRITE_ENABLED = "true";
    delete require.cache[modulePath];
    const env = require(modulePath);
    assert.equal(env.MAGALU_OAUTH_SCOPES.includes("open:order-order-seller:write"), false);
    assert.equal(env.MAGALU_OAUTH_SCOPES.includes("open:portfolio-skus-seller:read"), true);
    assert.equal(env.MAGALU_OAUTH_SCOPES.includes("open:order-delivery-seller:write"), true);
  } finally {
    if (previous.scopes === undefined) delete process.env.MAGALU_OAUTH_SCOPES;
    else process.env.MAGALU_OAUTH_SCOPES = previous.scopes;
    if (previous.invoice === undefined) delete process.env.MAGALU_INVOICE_WRITE_ENABLED;
    else process.env.MAGALU_INVOICE_WRITE_ENABLED = previous.invoice;
    delete require.cache[modulePath];
  }
});
