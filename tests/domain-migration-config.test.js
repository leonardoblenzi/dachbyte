"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DOMAIN_MIGRATION_PLAN,
  createDomainMigrationPlan,
  normalizeOrigin,
} = require("../platform/config/domainMigration");

test("domain migration is inert until a canonical DACHBYTE origin exists", () => {
  assert.equal(DOMAIN_MIGRATION_PLAN.configured, false);
  assert.equal(DOMAIN_MIGRATION_PLAN.canonicalOrigin, null);
  assert.equal(DOMAIN_MIGRATION_PLAN.publicUrls.seller, null);
  assert.equal(DOMAIN_MIGRATION_PLAN.oauth.stage, "not-configured");
  assert.equal(DOMAIN_MIGRATION_PLAN.cookies.stage, "legacy-only");
  assert.equal(DOMAIN_MIGRATION_PLAN.cookies.existingNamesUnchanged, true);
});

test("a future plan creates canonical URLs while preserving legacy rollout", () => {
  const plan = createDomainMigrationPlan({
    canonicalOrigin: "https://dachbyte.example/",
    legacyOrigins: ["https://legacy.example", "https://legacy.example/"],
  });

  assert.equal(plan.canonicalOrigin, "https://dachbyte.example");
  assert.deepEqual(plan.legacyOrigins, ["https://legacy.example"]);
  assert.equal(plan.publicUrls.seller, "https://dachbyte.example/seller");
  assert.equal(plan.publicUrls.business, "https://dachbyte.example/business");
  assert.equal(plan.oauth.legacyCallbacksRemainActive, true);
  assert.equal(plan.cookies.stage, "legacy-only");
});

test("domain planning accepts origins only, never callback paths", () => {
  assert.equal(normalizeOrigin("https://dachbyte.example/"), "https://dachbyte.example");
  assert.throws(() => normalizeOrigin("https://dachbyte.example/oauth/callback"), /cannot include a path/);
  assert.throws(
    () => createDomainMigrationPlan({ canonicalOrigin: "https://same.example", legacyOrigins: ["https://same.example"] }),
    /must not also be listed as legacy/,
  );
});
