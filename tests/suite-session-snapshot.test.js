"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createSuiteSessionSnapshotService } = require("../apps/gateway/services/suiteSessionSnapshot");

test("builds a fresh Seller-only snapshot from Hub access", async () => {
  const requests = [];
  const service = createSuiteSessionSnapshotService({
    baseUrl: "https://paymentcontrol.example",
    internalToken: "test-internal-token",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          allow: true,
          name: "Drossi",
          email: "cadastro4drossi@gmail.com",
          modules: ["ml", "magalu", "dach_ads"],
          seller_modules: ["ml", "magalu"],
          subscription_status: "active",
          subscription_active: true,
          expires_at: "2026-10-24T00:00:00.000Z",
          days_until_expiration: 30,
          renewal_url: "https://hub.example/renew",
          renewable_resources: [],
        }),
      };
    },
  });

  const snapshot = await service.resolve({
    tenant_id: "tenant-drossi",
    user_id: "user-drossi",
    email: "cadastro4drossi@gmail.com",
    nome: "Cadastro Drossi",
  });

  assert.deepEqual(snapshot, {
    ok: true,
    logged: true,
    user: { name: "Drossi", email: "cadastro4drossi@gmail.com" },
    entitlements: { modules: ["ml", "magalu"], seller_modules: ["ml", "magalu"] },
    subscription: {
      status: "active",
      active: true,
      expires_at: "2026-10-24T00:00:00.000Z",
      days_until_expiration: 30,
      renewal_url: "https://hub.example/renew",
      renewable_resources: [],
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://paymentcontrol.example/v1/access/check");
  assert.equal(requests[0].options.headers.authorization, "Bearer test-internal-token");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    tenant_id: "tenant-drossi",
    user_id: "user-drossi",
    module: "suite",
    action: "SESSION",
  });
});

test("fails closed when the Hub denies the suite session", async () => {
  const service = createSuiteSessionSnapshotService({
    baseUrl: "https://paymentcontrol.example",
    internalToken: "test-internal-token",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ allow: false, reason: "subscription_inactive" }),
    }),
  });

  const snapshot = await service.resolve({ tenant_id: "tenant", user_id: "user" });

  assert.deepEqual(snapshot, {
    ok: false,
    logged: true,
    code: "subscription_inactive",
  });
});
