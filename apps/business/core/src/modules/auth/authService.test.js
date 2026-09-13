const test = require("node:test");
const assert = require("node:assert/strict");
const authService = require("./authService");

test("requires the authentication database instead of creating a fictitious local user", async () => {
  await assert.rejects(
    authService.login({ email: "admin", password: "senha" }),
    (error) => error.status === 503 && /Banco de autenticacao nao configurado/.test(error.message),
  );
});

test("returns the complete master management contract without a database", async () => {
  const overview = await authService.getMasterOverview();

  assert.ok(Array.isArray(overview.companies));
  assert.ok(Array.isArray(overview.users));
  assert.ok(Array.isArray(overview.auditEvents));
  assert.ok(Array.isArray(overview.segmentDistribution));
  assert.ok(Array.isArray(overview.companyActivity));
  assert.equal(typeof overview.system, "object");
  assert.equal(typeof overview.totals.companies, "number");
});

test("accepts a module-scoped Hub grant and rejects conflicting module lists", () => {
  assert.equal(authService.__test.hasVoltCoreHubAccess({ allow: true }), true);
  assert.equal(authService.__test.hasVoltCoreHubAccess({ allow: true, modules: ["volt_core"] }), true);
  assert.equal(authService.__test.hasVoltCoreHubAccess({ allow: true, allowed_modules: [{ id: "volt-core" }] }), true);
  assert.equal(authService.__test.hasVoltCoreHubAccess({ allow: true, modules: ["ml"] }), false);
  assert.equal(authService.__test.hasVoltCoreHubAccess({ allow: false, modules: ["volt_core"] }), false);
});

test("assigns only the first lazy-provisioned company user as admin", () => {
  assert.equal(authService.__test.companyRoleForLazyProvision(null, 0), "admin");
  assert.equal(authService.__test.companyRoleForLazyProvision(null, 1), "operator");
  assert.equal(authService.__test.companyRoleForLazyProvision("manager", 10), "manager");
});
