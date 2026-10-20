"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { stageVerifiedMlTrialIdentity } = require("../services/publicTrialIdentityStage");

const input = {
  token: "email-token", fullName: "Ana Seller", companyName: "Loja Ana",
  passwordHash: "$2b$10$already-hashed", now: new Date("2026-10-20T12:00:00.000Z")
};

test("email confirmation stages a non-operational user and company exactly once", async () => {
  const statements = [];
  const client = { query: async (statement, values) => {
    statements.push({ statement, values });
    if (/FROM public_trial_oauth_sessions/i.test(statement)) return { rows: [{
      id: "session-1", email: "ana@example.test", ml_user_id: "123",
      status: "email_pending", activation_expires_at: "2026-10-21T12:00:00.000Z"
    }] };
    if (/FROM usuarios/i.test(statement) || /FROM meli_contas/i.test(statement)) return { rows: [] };
    if (/INSERT INTO empresas/i.test(statement)) return { rows: [{ id: 10 }] };
    if (/INSERT INTO usuarios/i.test(statement)) return { rows: [{ id: 20 }] };
    if (/UPDATE public_trial_oauth_sessions/i.test(statement)) return { rows: [{ id: "session-1" }] };
    return { rows: [] };
  }, release() {} };
  const db = { connect: async () => client };
  const result = await stageVerifiedMlTrialIdentity(db, input);
  assert.equal(result.companyId, 10);
  assert.equal(result.userId, 20);
  assert.equal(result.mlUserId, 123);
  assert.ok(statements.some(({ statement }) => /INSERT INTO empresas/i.test(statement)));
  assert.ok(statements.some(({ statement }) => /INSERT INTO usuarios[\s\S]*pendente_ativacao/i.test(statement)));
  assert.equal(statements.some(({ statement }) => /INSERT INTO meli_contas/i.test(statement)), false);
  assert.equal(statements.some(({ statement }) => /INSERT INTO meli_tokens/i.test(statement)), false);
  assert.equal(statements.some(({ statement }) => /seller_module_trials/i.test(statement)), false);
});

test("retry uses the same staged identity without creating another company", async () => {
  const statements = [];
  const client = { query: async (statement) => {
    statements.push(statement);
    if (/FROM public_trial_oauth_sessions/i.test(statement)) return { rows: [{
      id: "session-1", email: "ana@example.test", ml_user_id: "123",
      status: "identity_staged", empresa_id: 10, usuario_id: 20,
      tenant_global_id: "tenant-1", user_global_id: "user-1",
      stored_company_name: "Loja original", stored_full_name: "Ana original",
      activation_expires_at: "2026-10-21T12:00:00.000Z"
    }] };
    return { rows: [] };
  }, release() {} };
  const db = { connect: async () => client };
  const result = await stageVerifiedMlTrialIdentity(db, input);
  assert.equal(result.companyId, 10);
  assert.equal(result.tenantId, "tenant-1");
  assert.equal(result.companyName, "Loja original");
  assert.equal(result.fullName, "Ana original");
  assert.equal(statements.some((statement) => /INSERT INTO empresas|INSERT INTO usuarios/i.test(statement)), false);
});

test("existing local email requires login and never creates another company", async () => {
  const statements = [];
  const client = { query: async (statement) => {
    statements.push(statement);
    if (/FROM public_trial_oauth_sessions/i.test(statement)) return { rows: [{
      id: "session-1", email: "ana@example.test", ml_user_id: "123",
      status: "email_pending", activation_expires_at: "2026-10-21T12:00:00.000Z"
    }] };
    if (/FROM usuarios/i.test(statement)) return { rows: [{ id: 99 }] };
    return { rows: [] };
  }, release() {} };
  const db = { connect: async () => client };
  await assert.rejects(stageVerifiedMlTrialIdentity(db, input), /trial_email_login_required/);
  assert.equal(statements.some((statement) => /INSERT INTO empresas/i.test(statement)), false);
});
