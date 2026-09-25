"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const accountController = require("../src/controllers/accountController");
const managementRepo = require("../src/repositories/accountManagementRepository");
const helpService = require("../src/services/helpContactService");

const root = path.resolve(__dirname, "..");

function read(...parts) {
  return fs.readFileSync(path.join(root, ...parts), "utf8");
}

test("blocking write states protect remote uncertainty before unlink", () => {
  assert.deepEqual(managementRepo.BLOCKING_WRITE_STATES, [
    "queued", "running", "dispatching", "accepted", "divergent", "uncertain",
  ]);
});

test("subscription projection keeps only account-safe billing fields", () => {
  const result = accountController._test.pickSubscription({
    active: true,
    status: "active",
    plan_code: "seller_pro",
    plan_name: "Seller Pro",
    cycle: "monthly",
    expires_at: "2026-10-01T00:00:00Z",
    renewal_url: "https://dachbyte.tech/renew",
    secret: "must-not-leak",
  });
  assert.equal(result.active, true);
  assert.equal(result.plan_code, "seller_pro");
  assert.equal(Object.hasOwn(result, "secret"), false);
});

test("Hub access projection never exposes arbitrary payload fields", () => {
  const result = accountController._test.pickHubAccess({
    allow: true,
    reason: "ok",
    resource: { status: "active", billing_mode: "paid", usage_policy: "metered", plan_code: "magalu" },
    wallet: { balance: 42 },
    internal_token: "must-not-leak",
  });
  assert.equal(result.allow, true);
  assert.equal(result.credit_balance, 42);
  assert.equal(Object.hasOwn(result, "internal_token"), false);
});

test("help email is Magalu-specific and does not include OAuth secrets", () => {
  const html = helpService._test.buildHtml({
    userName: "Teste",
    userEmail: "teste@example.com",
    topic: "integracao",
    message: "Falha de sincronização",
    accountLabel: "Conta Seller",
    magaluTenantId: "tenant-1",
    requestId: "request-123",
  });
  assert.match(html, /DACHBYTE Seller · Magalu/);
  assert.match(html, /request-123/);
  assert.doesNotMatch(html, /access_token|refresh_token|Bearer/i);
});

test("frontend exposes linked accounts, centralized users, billing and help", () => {
  const source = read("public", "js", "magalu-account.js");
  for (const label of ["Contas vinculadas", "Usuários", "Plano e créditos", "Integrações", "Ajuda e contato", "Desvincular conta"]) {
    assert.ok(source.includes(label), label);
  }
  assert.doesNotMatch(source, /seller-ml|meli_conta_id|meli_user_id/);
});

test("account API is isolated under the Magalu module", () => {
  const routes = read("src", "routes", "account.routes.js");
  assert.match(routes, /accounts\/:accountId\/unlink/);
  assert.match(routes, /\/context/);
  assert.match(routes, /\/help/);
  assert.doesNotMatch(routes, /seller-ml|\/ml\//);
});
