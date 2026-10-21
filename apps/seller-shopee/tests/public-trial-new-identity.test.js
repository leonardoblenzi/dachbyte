"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  stageVerifiedShopeeIdentity,
  confirmHubTrialActivation,
} = require("../src/services/publicTrialNewIdentity");

test("Shopee identity stage keeps a new account pending until Hub confirms", async () => {
  const sql = [];
  const client = { query: async (statement) => {
    sql.push(statement);
    if (statement.includes("FROM public_trial_oauth_sessions")) return { rows: [{
      id: "session-1", status: "email_pending", email: "new@example.com", shop_id: "123",
    }] };
    if (statement.includes('FROM "User"') || statement.includes('FROM "Shop"')) return { rows: [] };
    if (statement.includes('INSERT INTO "Account"')) return { rows: [{ id: 10 }] };
    if (statement.includes('INSERT INTO "User"')) return { rows: [{ id: 20 }] };
    if (statement.includes('UPDATE public_trial_oauth_sessions')) return { rows: [{ id: "session-1" }] };
    return { rows: [] };
  } };
  const pool = { connect: async () => ({ ...client, release() {} }) };
  const staged = await stageVerifiedShopeeIdentity(pool, {
    token: "verified-token", fullName: "Novo Usuário", companyName: "Nova Empresa",
    passwordHash: "$2b$10$hash", reserveId: async (_client, table) => table === "Account" ? 10 : 20,
  });
  assert.equal(staged.tenantId.length > 0, true);
  assert.equal(staged.email, "new@example.com");
  assert.equal(sql.some((statement) => statement.includes("'PENDING'")), true);
  assert.equal(sql.some((statement) => statement.includes('INSERT INTO "Shop"')), false);
  assert.equal(sql.some((statement) => statement.includes("COMMIT")), true);
});

test("Hub confirmation must match the exact Shopee tenant and shop", () => {
  const activation = { trial: { endsAt: "2099-01-01T00:00:00Z" }, resource: {
    resource_key: "shopee:123", tenant_id: "tenant-1", access_policy: "temporary",
  } };
  assert.equal(confirmHubTrialActivation({ tenantId: "tenant-1", shopId: "123", activation }).trialActive, true);
  assert.throws(() => confirmHubTrialActivation({ tenantId: "tenant-2", shopId: "123", activation }),
    /trial_hub_confirmation_invalid/);
});
