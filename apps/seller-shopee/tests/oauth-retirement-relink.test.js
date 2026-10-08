"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { buildResourceContext } = require("../src/services/hubResourceBillingService");

test("Shopee marks only the verified shop OAuth callback for Hub reactivation", () => {
  const context = buildResourceContext({
    auth: { tenantGlobalId: "tenant-a" }, shop: { id: 7, shopId: 123n },
    oauthConfirmed: true,
  });
  assert.equal(context.oauthConfirmed, true);
  assert.equal(context.accountId, "123");
});

test("Shopee shop callback sends the confirmation but Ads callback does not", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/controllers/AuthController.js"), "utf8");
  assert.match(source, /oauthConfirmed:\s*authFlow\s*===\s*"shop"/);
});
