"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { finalizeShopeeTrial } = require("../src/services/publicTrialFinalization");
const { encryptTrialToken } = require("../src/services/publicTrialOAuthSession");

const key = "a".repeat(64);
const activation = { trial: { endsAt: "2099-01-01T00:00:00Z" }, resource: {
  resource_key: "shopee:123", tenant_id: "tenant-1", access_policy: "temporary",
} };

test("confirmed Shopee trial makes account, token and user operational in one transaction", async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes("FROM public_trial_oauth_sessions")) return { rows: [{
      id: "session-1", status: "identity_staged", account_id: 10, user_id: 20,
      tenant_global_id: "tenant-1", shop_id: "123",
      access_token_enc: encryptTrialToken("access", key),
      refresh_token_enc: encryptTrialToken("refresh", key),
    }] };
    if (sql.includes('FROM "Shop"')) return { rows: [] };
    if (sql.includes('FROM "User"')) return { rows: [{ id: 20, status: "PENDING", account_id: 10 }] };
    if (sql.includes('INSERT INTO "Shop"')) return { rows: [{ id: 30 }] };
    if (sql.includes('UPDATE "User"')) return { rows: [{ id: 20 }] };
    if (sql.includes('UPDATE public_trial_oauth_sessions')) return { rows: [{ id: "session-1" }] };
    return { rows: [] };
  }, release() {} };
  const result = await finalizeShopeeTrial({ connect: async () => client }, {
    sessionId: "session-1", tenantId: "tenant-1", shopId: "123", activation, encryptionKey: key,
  });
  assert.equal(result.shopDbId, 30);
  const tokenInsert = calls.find((call) => call.sql.includes('INSERT INTO "OAuthToken"'));
  assert.equal(tokenInsert.values.includes("access"), true);
  assert.equal(tokenInsert.values.includes("refresh"), true);
  assert.equal(calls.some((call) => call.sql === "COMMIT"), true);
  assert.equal(calls.some((call) => call.sql.includes("access_token_enc = NULL")), true);
});

test("wrong Hub resource never starts local finalization", async () => {
  const wrong = { ...activation, resource: { ...activation.resource, resource_key: "shopee:999" } };
  await assert.rejects(finalizeShopeeTrial({ connect: async () => { throw new Error("DB should not open"); } }, {
    sessionId: "session-1", tenantId: "tenant-1", shopId: "123", activation: wrong, encryptionKey: key,
  }), /trial_hub_confirmation_invalid/);
});

test("existing ACTIVE user stays active and is never replaced during shop finalization", async () => {
  const calls = [];
  const client = { query: async (sql) => {
    calls.push(sql);
    if (sql.includes("FROM public_trial_oauth_sessions")) return { rows: [{
      id: "session-1", status: "identity_staged", account_id: 10, user_id: 20,
      tenant_global_id: "tenant-1", shop_id: "123",
      access_token_enc: encryptTrialToken("access", key),
      refresh_token_enc: encryptTrialToken("refresh", key),
    }] };
    if (sql.includes('FROM "User"')) return { rows: [{ id: 20, status: "ACTIVE", account_id: 10 }] };
    if (sql.includes('FROM "Shop"')) return { rows: [] };
    if (sql.includes('INSERT INTO "Shop"')) return { rows: [{ id: 30 }] };
    if (sql.includes('UPDATE public_trial_oauth_sessions')) return { rows: [{ id: "session-1" }] };
    return { rows: [] };
  }, release() {} };
  const result = await finalizeShopeeTrial({ connect: async () => client }, {
    sessionId: "session-1", tenantId: "tenant-1", shopId: "123", activation, encryptionKey: key,
  });
  assert.equal(result.shopDbId, 30);
  assert.equal(calls.some((sql) => sql.includes('UPDATE "User"')), false);
});
