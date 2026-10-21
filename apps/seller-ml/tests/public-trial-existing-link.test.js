"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  listExistingTrialCompanies,
  stageExistingMlTrialLink,
} = require("../services/publicTrialExistingLink");

test("login flow lists only companies belonging to the authenticated email", async () => {
  const db = { query: async (sql, values) => {
    if (/FROM public_trial_oauth_sessions/i.test(sql)) return { rows: [{
      id: "session-1", email: "ana@example.test", status: "awaiting_login"
    }] };
    if (/FROM usuarios/i.test(sql)) {
      assert.equal(values[0], 20);
      return { rows: [{ id: 20, email: "ana@example.test", status: "ativo" }] };
    }
    if (/FROM empresa_usuarios/i.test(sql)) return { rows: [{ id: 10, nome: "Loja Ana" }] };
    return { rows: [] };
  } };
  const result = await listExistingTrialCompanies(db, { browserNonce: "nonce", userId: 20 });
  assert.deepEqual(result.companies, [{ id: 10, name: "Loja Ana" }]);
});

test("selected company must be an actual membership of the authenticated user", async () => {
  const statements = [];
  const client = { query: async (sql) => {
    statements.push(sql);
    if (/FROM public_trial_oauth_sessions/i.test(sql)) return { rows: [{
      id: "session-1", email: "ana@example.test", ml_user_id: 123,
      status: "awaiting_login", activation_expires_at: "2026-10-21T12:00:00.000Z"
    }] };
    if (/FROM usuarios/i.test(sql)) return { rows: [{ id: 20, email: "ana@example.test", status: "ativo" }] };
    if (/FROM empresa_usuarios/i.test(sql)) return { rows: [] };
    return { rows: [] };
  }, release() {} };
  await assert.rejects(stageExistingMlTrialLink({ connect: async () => client }, {
    browserNonce: "nonce", userId: 20, companyId: 99,
    now: new Date("2026-10-20T12:00:00.000Z")
  }), /trial_company_membership_required/);
  assert.equal(statements.some((sql) => /INSERT INTO empresas|INSERT INTO usuarios/i.test(sql)), false);
  assert.ok(statements.includes("ROLLBACK"));
});

test("matching login stages existing identity without creating a second company", async () => {
  const statements = [];
  const client = { query: async (sql) => {
    statements.push(sql);
    if (/FROM public_trial_oauth_sessions/i.test(sql)) return { rows: [{
      id: "session-1", email: "ana@example.test", ml_user_id: 123,
      status: "awaiting_login", activation_expires_at: "2026-10-21T12:00:00.000Z"
    }] };
    if (/FROM usuarios/i.test(sql)) return { rows: [{
      id: 20, email: "ana@example.test", nome: "Ana", status: "ativo", user_global_id: "user-1"
    }] };
    if (/FROM empresa_usuarios/i.test(sql)) return { rows: [{
      id: 10, nome: "Loja Ana", papel: "admin", tenant_global_id: "tenant-1"
    }] };
    if (/FROM meli_contas/i.test(sql)) return { rows: [] };
    if (/UPDATE public_trial_oauth_sessions/i.test(sql)) return { rows: [{ id: "session-1" }] };
    return { rows: [] };
  }, release() {} };
  const result = await stageExistingMlTrialLink({ connect: async () => client }, {
    browserNonce: "nonce", userId: 20, companyId: 10,
    now: new Date("2026-10-20T12:00:00.000Z")
  });
  assert.equal(result.tenantId, "tenant-1");
  assert.equal(result.role, "admin");
  assert.ok(statements.some((sql) => /existing_identity_staged/i.test(sql)));
  assert.equal(statements.some((sql) => /INSERT INTO empresas|INSERT INTO usuarios|INSERT INTO meli_contas/i.test(sql)), false);
});
