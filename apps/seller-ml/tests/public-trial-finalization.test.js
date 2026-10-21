"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { finalizeConfirmedMlTrial } = require("../services/publicTrialFinalization");

const input = {
  sessionId: "session-1", tenantId: "tenant-1", mlUserId: 123,
  activation: {
    trial: { endsAt: "2026-10-27T12:00:00.000Z" },
    resource: { resource_key: "ml:123", tenant_id: "tenant-1", access_policy: "temporary" }
  }
};

test("Hub confirmation is required before local account and OAuth tokens become operational", async () => {
  let connected = false;
  const pool = { connect: async () => { connected = true; throw new Error("unexpected connection"); } };
  await assert.rejects(finalizeConfirmedMlTrial(pool, {
    ...input, activation: { trial: input.activation.trial, resource: { resource_key: "ml:123" } }
  }), /trial_hub_confirmation_invalid/);
  assert.equal(connected, false);
});

test("confirmed Hub trial finalizes account, tokens and user in one transaction", async () => {
  const statements = [];
  const client = { query: async (statement, values) => {
    statements.push({ statement, values });
    if (/FROM public_trial_oauth_sessions/i.test(statement)) return { rows: [{
      id: "session-1", status: "identity_staged", empresa_id: 10, usuario_id: 20,
      tenant_global_id: "tenant-1", ml_user_id: 123, access_token_enc: "enc::v1::access",
      refresh_token_enc: "enc::v1::refresh", access_expires_at: "2026-10-20T18:00:00.000Z",
      scope: "offline_access"
    }] };
    if (/SELECT id.*FROM meli_contas/is.test(statement)) return { rows: [] };
    if (/INSERT INTO meli_contas/i.test(statement)) return { rows: [{ id: 30 }] };
    if (/UPDATE usuarios/i.test(statement)) return { rows: [{ id: 20 }] };
    if (/UPDATE public_trial_oauth_sessions/i.test(statement)) return { rows: [{ id: "session-1" }] };
    return { rows: [] };
  }, release() {} };
  const result = await finalizeConfirmedMlTrial({ connect: async () => client }, input);
  assert.equal(result.accountId, 30);
  assert.ok(statements.some(({ statement, values }) =>
    /INSERT INTO meli_contas[\s\S]*'trial'/i.test(statement) && values.includes("active")));
  assert.ok(statements.some(({ statement }) => /INSERT INTO meli_tokens/i.test(statement)));
  assert.ok(statements.some(({ statement }) => /INSERT INTO ml_closed_month_order_measurements/i.test(statement)));
  assert.ok(statements.some(({ statement }) => /UPDATE usuarios[\s\S]*status = 'ativo'/i.test(statement)));
  assert.ok(statements.some(({ statement }) => /access_token_enc = NULL/i.test(statement)));
  assert.equal(statements.at(-1).statement, "COMMIT");
});

test("second completion returns original account without writing tokens again", async () => {
  const statements = [];
  const client = { query: async (statement) => {
    statements.push(statement);
    if (/FROM public_trial_oauth_sessions/i.test(statement)) return { rows: [{
      id: "session-1", status: "activated", empresa_id: 10, usuario_id: 20,
      meli_conta_id: 30, tenant_global_id: "tenant-1", ml_user_id: 123
    }] };
    return { rows: [] };
  }, release() {} };
  const result = await finalizeConfirmedMlTrial({ connect: async () => client }, input);
  assert.equal(result.accountId, 30);
  assert.equal(statements.some((statement) => /INSERT INTO meli_tokens/i.test(statement)), false);
});

test("existing user is not reactivated or changed when their ML trial link is finalized", async () => {
  const statements = [];
  const client = { query: async (statement) => {
    statements.push(statement);
    if (/FROM public_trial_oauth_sessions/i.test(statement)) return { rows: [{
      id: "session-1", status: "existing_identity_staged", empresa_id: 10,
      usuario_id: 20, tenant_global_id: "tenant-1", ml_user_id: 123,
      access_token_enc: "enc::v1::access", refresh_token_enc: "enc::v1::refresh",
      access_expires_at: "2026-10-20T18:00:00.000Z"
    }] };
    if (/FROM meli_contas/i.test(statement)) return { rows: [] };
    if (/INSERT INTO meli_contas/i.test(statement)) return { rows: [{ id: 30 }] };
    if (/UPDATE public_trial_oauth_sessions/i.test(statement)) return { rows: [{ id: "session-1" }] };
    return { rows: [] };
  }, release() {} };
  const result = await finalizeConfirmedMlTrial({ connect: async () => client }, input);
  assert.equal(result.accountId, 30);
  assert.equal(statements.some((statement) => /UPDATE usuarios/i.test(statement)), false);
  assert.ok(statements.includes("COMMIT"));
});

test("an already expired company trial links the account without presenting active trial billing", async () => {
  const statements = [];
  const client = { query: async (statement, values) => {
    statements.push({ statement, values });
    if (/FROM public_trial_oauth_sessions/i.test(statement)) return { rows: [{
      id: "session-1", status: "existing_identity_staged", empresa_id: 10,
      usuario_id: 20, tenant_global_id: "tenant-1", ml_user_id: 123,
      access_token_enc: "enc::v1::access", refresh_token_enc: "enc::v1::refresh",
      access_expires_at: "2026-10-20T18:00:00.000Z"
    }] };
    if (/FROM meli_contas/i.test(statement)) return { rows: [] };
    if (/INSERT INTO meli_contas/i.test(statement)) return { rows: [{ id: 30 }] };
    if (/UPDATE public_trial_oauth_sessions/i.test(statement)) return { rows: [{ id: "session-1" }] };
    return { rows: [] };
  }, release() {} };
  const result = await finalizeConfirmedMlTrial({ connect: async () => client }, {
    ...input, activation: { ...input.activation, trial: { endsAt: "2020-01-01T00:00:00.000Z" } }
  });
  assert.equal(result.trialActive, false);
  const accountWrite = statements.find(({ statement }) => /INSERT INTO meli_contas/i.test(statement));
  assert.ok(accountWrite?.values.includes("awaiting_subscription"));
});
