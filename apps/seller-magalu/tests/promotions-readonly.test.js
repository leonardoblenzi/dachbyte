"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("promotion capabilities require read scope and never enable unpublished writes", () => {
  const capability = require("../src/services/promotionCapabilityService");
  assert.deepEqual(capability.forAccount({
    id: 42,
    status: "active",
    scopes: ["open:promotion-promotions-seller:read"],
  }), {
    list: true,
    detail: true,
    promotionSkuRead: false,
    promotionSkuWrite: false,
    subscriptionWrite: false,
    apply: false,
  });
  assert.equal(capability.forAccount({ status: "active", scopes: [] }).list, false);
  assert.equal(capability.forAccount({
    status: "revoked",
    scopes: [capability.READ_SCOPE],
  }).detail, false);
});

test("OAuth defaults request promotional read and no promotional write", () => {
  const source = read("src/config/env.js");
  assert.match(source, /open:promotion-promotions-seller:read/);
  assert.doesNotMatch(source, /open:promotion-skus-seller:write/);
  assert.doesNotMatch(source, /open:promotion-subscriptions-seller:write/);
});
