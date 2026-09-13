"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CANONICAL_ROUTE_GROUPS,
  getCanonicalRedirect,
} = require("../platform/gateway");

test("seller canonical paths target the current mounts and preserve suffix/query", () => {
  assert.equal(getCanonicalRedirect("/seller", "", "seller"), "/landing");
  assert.equal(
    getCanonicalRedirect("/seller/mercado-livre/admin/dashboard", "?company=acme", "seller"),
    "/ml/admin/dashboard?company=acme",
  );
  assert.equal(
    getCanonicalRedirect("/seller/cloner", "?source=landing", "seller"),
    "/ml/clonar-anuncio?source=landing",
  );
});

test("business canonical paths target the current mounts and preserve suffix/query", () => {
  assert.equal(getCanonicalRedirect("/business", "", "business"), "/");
  assert.equal(
    getCanonicalRedirect("/business/core/app/dashboard", "?company=42", "business"),
    "/core/app/dashboard?company=42",
  );
  assert.equal(getCanonicalRedirect("/business/stock/locations", "?view=map", "business"), "/voltstock/locations?view=map");
});

test("canonical route tables expose both public product families", () => {
  assert.equal(CANONICAL_ROUTE_GROUPS.seller.length, 8);
  assert.equal(CANONICAL_ROUTE_GROUPS.business.length, 5);
  assert.equal(getCanonicalRedirect("/seller/unknown", "", "seller"), null);
  assert.equal(getCanonicalRedirect("/other", "", "business"), null);
});
