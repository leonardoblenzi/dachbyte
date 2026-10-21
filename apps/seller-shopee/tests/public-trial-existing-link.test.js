"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { linkExistingShopeeTrial } = require("../src/services/publicTrialExistingLink");

test("existing-company trial links only after Hub confirms exact tenant and shop", async () => {
  const calls = [];
  const linked = await linkExistingShopeeTrial({
    browserNonce: "nonce", identity: { tenantId: "tenant-1", userId: "user-1",
      email: "owner@example.com", companyName: "Empresa", fullName: "Owner", role: "admin" },
  }, {
    encryptionKey: "a".repeat(64),
    stageIdentity: async () => { calls.push("stage"); return { sessionId: "session-1",
      tenantId: "tenant-1", globalUserId: "user-1", email: "owner@example.com",
      companyName: "Empresa", fullName: "Owner", shopId: "123" }; },
    activateHub: async (input) => { calls.push("hub"); assert.equal(input.newIdentity, false);
      assert.equal(input.role, "admin");
      return { trial: { endsAt: "2099-01-01T00:00:00Z" }, resource: {
        resource_key: "shopee:123", tenant_id: "tenant-1", access_policy: "temporary",
      } }; },
    finalizeTrial: async () => { calls.push("local"); return { shopDbId: 30, trialActive: true }; },
  });
  assert.deepEqual(calls, ["stage", "hub", "local"]);
  assert.equal(linked.shopId, "123");
});

test("Hub failure leaves existing-company shop provisional", async () => {
  let finalized = false;
  await assert.rejects(() => linkExistingShopeeTrial({
    browserNonce: "nonce", identity: { tenantId: "tenant-1", userId: "user-1",
      email: "owner@example.com", companyName: "Empresa", fullName: "Owner" },
  }, {
    encryptionKey: "a".repeat(64),
    stageIdentity: async () => ({ sessionId: "session-1", tenantId: "tenant-1",
      globalUserId: "user-1", email: "owner@example.com", companyName: "Empresa",
      fullName: "Owner", shopId: "123" }),
    activateHub: async () => { throw new Error("hub_unavailable"); },
    finalizeTrial: async () => { finalized = true; },
  }), /hub_unavailable/);
  assert.equal(finalized, false);
});

test("an expired company trial keeps its original end and still links the shop", async () => {
  let finalized = false;
  const result = await linkExistingShopeeTrial({
    browserNonce: "nonce", identity: { tenantId: "tenant-1", userId: "user-1",
      email: "owner@example.com", companyName: "Empresa", fullName: "Owner" },
  }, {
    encryptionKey: "a".repeat(64),
    stageIdentity: async () => ({ sessionId: "session-1", tenantId: "tenant-1",
      globalUserId: "user-1", email: "owner@example.com", companyName: "Empresa",
      fullName: "Owner", shopId: "123" }),
    activateHub: async () => ({ trial: { endsAt: "2020-01-01T00:00:00Z" }, resource: {
      resource_key: "shopee:123", tenant_id: "tenant-1", access_policy: "temporary",
    } }),
    finalizeTrial: async () => { finalized = true; return { shopDbId: 30, trialActive: false }; },
  });
  assert.equal(finalized, true);
  assert.equal(result.trialActive, false);
});

test("missing gateway token key fails before touching identity or Hub", async () => {
  let staged = false;
  await assert.rejects(() => linkExistingShopeeTrial({
    browserNonce: "nonce", identity: { tenantId: "tenant-1", userId: "user-1",
      email: "owner@example.com", companyName: "Empresa", fullName: "Owner" },
  }, {
    encryptionKey: "invalid",
    stageIdentity: async () => { staged = true; },
  }), /trial_encryption_key_invalid/);
  assert.equal(staged, false);
});
