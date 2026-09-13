const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canonicalizeDatabaseTarget,
  resolveAvantrackingDatabaseUrl,
} = require("./databaseTarget.cjs");

test("requires AVANTRACKING_DATABASE_URL without DATABASE_URL fallback", () => {
  assert.throws(
    () => resolveAvantrackingDatabaseUrl({ DATABASE_URL: "postgresql://u:p@shopee/neondb" }),
    /AVANTRACKING_DATABASE_URL/,
  );
});

test("treats Neon direct and pooler hosts as the same target", () => {
  const direct = canonicalizeDatabaseTarget("postgresql://u:p@ep-sample.us-west-2.aws.neon.tech/neondb?sslmode=require");
  const pooler = canonicalizeDatabaseTarget("postgresql://u:p@ep-sample-pooler.us-west-2.aws.neon.tech/neondb?sslmode=require");
  assert.equal(direct.fingerprint, pooler.fingerprint);
});

test("rejects an Avantracking target equal to DATABASE_URL", () => {
  assert.throws(
    () => resolveAvantrackingDatabaseUrl({
      DATABASE_URL: "postgresql://u:p@ep-sample-pooler.us-west-2.aws.neon.tech/neondb",
      AVANTRACKING_DATABASE_URL: "postgresql://u:p@ep-sample.us-west-2.aws.neon.tech/neondb",
    }),
    /mesmo banco/i,
  );
});
