"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { authorizedRetirementCall } = require("../lib/hubSellerRetirementAuth");

test("Hub retirement command requires the dedicated secret", () => {
  assert.equal(authorizedRetirementCall("Bearer dedicated-secret", "dedicated-secret"), true);
  assert.equal(authorizedRetirementCall("Bearer wrong-secret", "dedicated-secret"), false);
  assert.equal(authorizedRetirementCall("Bearer dedicated-secret", ""), false);
  assert.equal(authorizedRetirementCall("", "dedicated-secret"), false);
});
