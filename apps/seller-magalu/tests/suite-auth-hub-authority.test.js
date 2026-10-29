"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");
const jwt = require("jsonwebtoken");

const secret = "magalu-hub-authority-test-secret";

async function loadSuiteAuth(hubResult, run) {
  const modulePath = require.resolve("../src/middlewares/suiteAuth");
  delete require.cache[modulePath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "../config/env") return { SUITE_JWT_SECRET: secret };
    if (request === "../services/hubAccessService") {
      return { checkHubAccess: async () => hubResult };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return await run(require(modulePath));
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }
}

function requestWithoutMagaluClaim() {
  const token = jwt.sign({
    tenant_id: "tenant-1",
    user_id: "user-1",
    email: "seller@example.test",
    allowed_modules: ["ml"],
  }, secret);
  return { method: "GET", headers: { cookie: `suite_auth_token=${token}`, accept: "text/html" } };
}

test("Magalu accepts a valid suite session when the Hub authorizes the module", async () => {
  await loadSuiteAuth({ allow: true, reason: "ok", payload: { allow: true } }, async ({ readSuiteIdentity, suiteAuth }) => {
    const req = requestWithoutMagaluClaim();
    const res = { locals: {}, redirect: () => assert.fail("unexpected redirect") };
    assert.equal(readSuiteIdentity(req).ok, true);
    let nextCalled = false;
    await suiteAuth(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.magaluIdentity.dachTenantId, "tenant-1");
  });
});

test("Magalu does not use a soft Hub fallback to grant a module absent from the session", async () => {
  await loadSuiteAuth({ allow: true, reason: "hub_unavailable_soft_allow" }, async ({ suiteAuth }) => {
    const req = requestWithoutMagaluClaim();
    let redirected = "";
    const res = { redirect: (_status, path) => { redirected = path; } };
    await suiteAuth(req, res, () => assert.fail("unexpected access"));
    assert.equal(redirected, "/selecao-plataforma?module=magalu_denied");
  });
});
