"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

test("Seller selection never widens explicit Hub entitlements during renewal handling", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "apps", "seller-ml", "views", "selecao-plataforma.html"),
    "utf8",
  );

  assert.doesNotMatch(source, /const accessSet = subscriptionState\.expired \? visibleOrLegacy : allowed;/);
  assert.match(source, /const accessSet = allowed;/);
});
