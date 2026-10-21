"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { stageExistingShopeeIdentity } = require("../src/services/publicTrialExistingIdentity");

test("existing-company link requires the signed user's exact pending email", async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes("FROM public_trial_oauth_sessions")) return { rows: [{
      id: "session-1", status: "awaiting_login", email: "owner@example.com", shop_id: "123",
    }] };
    return { rows: [] };
  }, release() {} };
  const pool = { connect: async () => client };
  await assert.rejects(() => stageExistingShopeeIdentity(pool, {
    browserNonce: "nonce", identity: { email: "other@example.com", tenantId: "tenant-1",
      userId: "user-1", companyName: "Empresa", fullName: "Owner" },
  }), /trial_existing_identity_mismatch/);
  assert.equal(calls.some((call) => /INSERT INTO "Account"|INSERT INTO "User"/.test(call.sql)), false);
});

test("existing-company link stages the signed tenant and user without starting access", async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes("FROM public_trial_oauth_sessions")) return { rows: [{
      id: "session-1", status: "awaiting_login", email: "owner@example.com", shop_id: "123",
    }] };
    if (sql.includes('FROM "Account"')) return { rows: [{ id: 17, name: "Empresa" }] };
    if (sql.includes('FROM "User"')) return { rows: [{ id: 19, status: "ACTIVE", account_id: 17,
      user_global_id: "user-1" }] };
    if (sql.includes('FROM "Shop"')) return { rows: [] };
    if (sql.includes("UPDATE public_trial_oauth_sessions")) return { rows: [{ id: "session-1" }] };
    return { rows: [] };
  }, release() {} };
  const result = await stageExistingShopeeIdentity({ connect: async () => client }, {
    browserNonce: "nonce", identity: { email: "owner@example.com", tenantId: "tenant-1",
      userId: "user-1", companyName: "Empresa", fullName: "Owner" },
  });
  assert.equal(result.tenantId, "tenant-1");
  assert.equal(result.accountId, 17);
  assert.equal(result.shopId, "123");
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO "Shop"')), false);
  assert.equal(calls.some((call) => call.sql.includes("UPDATE public_trial_oauth_sessions")), true);
});

test("existing-company link rejects a local email owned by another tenant", async () => {
  const client = { query: async (sql) => {
    if (sql.includes("FROM public_trial_oauth_sessions")) return { rows: [{
      id: "session-1", status: "awaiting_login", email: "owner@example.com", shop_id: "123",
    }] };
    if (sql.includes('FROM "Shop"')) return { rows: [] };
    if (sql.includes('FROM "Account"')) return { rows: [{ id: 17 }] };
    if (sql.includes('FROM "User"')) return { rows: [{ id: 19, account_id: 18,
      user_global_id: "user-1", status: "ACTIVE" }] };
    return { rows: [] };
  }, release() {} };
  await assert.rejects(() => stageExistingShopeeIdentity({ connect: async () => client }, {
    browserNonce: "nonce", identity: { email: "owner@example.com", tenantId: "tenant-1",
      userId: "user-1", companyName: "Empresa", fullName: "Owner" },
  }), /trial_existing_identity_mismatch/);
});

test("legacy local Shopee user receives the signed global user id when missing", async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes("FROM public_trial_oauth_sessions")) return { rows: [{
      id: "session-1", status: "awaiting_login", email: "owner@example.com", shop_id: "123",
    }] };
    if (sql.includes('FROM "Shop"')) return { rows: [] };
    if (sql.includes('FROM "Account"')) return { rows: [{ id: 17 }] };
    if (sql.includes('FROM "User"')) return { rows: [{ id: 19, account_id: 17,
      user_global_id: null, status: "ACTIVE" }] };
    if (sql.includes('UPDATE "User"')) return { rows: [{ id: 19 }] };
    if (sql.includes("UPDATE public_trial_oauth_sessions")) return { rows: [{ id: "session-1" }] };
    return { rows: [] };
  }, release() {} };
  await stageExistingShopeeIdentity({ connect: async () => client }, {
    browserNonce: "nonce", identity: { email: "owner@example.com", tenantId: "tenant-1",
      userId: "user-1", companyName: "Empresa", fullName: "Owner" },
  });
  assert.equal(calls.some((call) => call.sql.includes('UPDATE "User"') &&
    call.values[1] === "user-1"), true);
});

test("ML-only company gets a provisional Shopee mirror of the same global tenant", async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes("FROM public_trial_oauth_sessions")) return { rows: [{
      id: "session-1", status: "awaiting_login", email: "owner@example.com", shop_id: "123",
    }] };
    if (sql.includes('FROM "Shop"') || sql.includes('FROM "Account"') || sql.includes('FROM "User"')) return { rows: [] };
    if (sql.includes('INSERT INTO "Account"')) return { rows: [{ id: 17, name: "Empresa" }] };
    if (sql.includes('INSERT INTO "User"')) return { rows: [{ id: 19, status: "PENDING",
      user_global_id: "user-1" }] };
    if (sql.includes("UPDATE public_trial_oauth_sessions")) return { rows: [{ id: "session-1" }] };
    return { rows: [] };
  }, release() {} };
  const result = await stageExistingShopeeIdentity({ connect: async () => client }, {
    browserNonce: "nonce", identity: { email: "owner@example.com", tenantId: "tenant-1",
      userId: "user-1", companyName: "Empresa", fullName: "Owner" },
    reserveId: async (_client, table) => table === "Account" ? 17 : 19,
  });
  assert.equal(result.tenantId, "tenant-1");
  assert.equal(calls.find((call) => call.sql.includes('INSERT INTO "Account"')).values[2], "tenant-1");
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO "User"') &&
    call.sql.includes("'PENDING'")), true);
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO "Shop"')), false);
});

test("repeating an already activated link returns the same shop for Hub recheck", async () => {
  const client = { query: async (sql) => {
    if (sql.includes("FROM public_trial_oauth_sessions")) return { rows: [{
      id: "session-1", status: "activated", email: "owner@example.com", shop_id: "123",
      account_id: 17, user_id: 19, shop_db_id: 30, tenant_global_id: "tenant-1",
      user_global_id: "user-1", stored_full_name: "Owner", stored_company_name: "Empresa",
    }] };
    return { rows: [] };
  }, release() {} };
  const result = await stageExistingShopeeIdentity({ connect: async () => client }, {
    browserNonce: "nonce", identity: { email: "owner@example.com", tenantId: "tenant-1",
      userId: "user-1", companyName: "Empresa", fullName: "Owner" },
  });
  assert.equal(result.shopId, "123");
  assert.equal(result.sessionId, "session-1");
});
