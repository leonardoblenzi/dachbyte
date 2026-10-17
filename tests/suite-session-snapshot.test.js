"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createSuiteSessionSnapshotService } = require("../apps/gateway/services/suiteSessionSnapshot");

test("builds a fresh Seller-only snapshot from the Hub portal overview", async () => {
  const requests = [];
  const service = createSuiteSessionSnapshotService({
    baseUrl: "https://paymentcontrol.example",
    internalToken: "test-internal-token",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          ok: true,
          user: { name: "Drossi", email: "cadastro4drossi@gmail.com" },
          modules: [
            { slug: "ml", installed: true, can_enter: true },
            { slug: "magalu", installed: true, can_enter: true },
            { slug: "dach_ads", installed: true, can_enter: true },
          ],
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
    entitlements: {
      modules: ["ml", "magalu"],
      seller_modules: ["ml", "magalu"],
      visible_modules: ["ml", "magalu"],
    },
    subscription: {
      status: "active",
      active: true,
      expires_at: null,
      days_until_expiration: null,
      renewal_url: null,
      renewable_resources: [],
    },
    portal: true,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://paymentcontrol.example/v1/internal/portal/overview");
  assert.equal(requests[0].options.headers.authorization, "Bearer test-internal-token");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    tenant_id: "tenant-drossi",
    user_id: "user-drossi",
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

test("keeps Seller modules active when the portal omits optional billing fields", async () => {
  const service = createSuiteSessionSnapshotService({
    baseUrl: "https://paymentcontrol.example",
    internalToken: "test-internal-token",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        modules: [
          { slug: "ml", installed: true, can_enter: true },
          { slug: "magalu", installed: true, can_enter: true },
        ],
      }),
    }),
  });

  const snapshot = await service.resolve({ tenant_id: "tenant", user_id: "user" });

  assert.deepEqual(snapshot.entitlements.modules, ["ml", "magalu"]);
  assert.equal(snapshot.subscription.status, "active");
  assert.equal(snapshot.subscription.active, true);
});

test("uses signed platform master scopes without treating the master as a commercial tenant", async () => {
  let hubCalls = 0;
  const service = createSuiteSessionSnapshotService({
    baseUrl: "https://hub.example",
    internalToken: "test-internal-token",
    fetchImpl: async () => {
      hubCalls += 1;
      throw new Error("platform master must not use the commercial suite check");
    },
  });

  const snapshot = await service.resolve({
    tenant_id: "platform-user-ml-master",
    user_id: "user-ml-master",
    email: "master@example.com",
    name: "Master ML",
    allowed_modules: ["ml"],
    visible_modules: ["ml", "volt_core"],
    subscription: { status: "active", active: true, is_master: true },
  });

  assert.equal(hubCalls, 0);
  assert.deepEqual(snapshot, {
    ok: true,
    logged: true,
    user: { name: "Master ML", email: "master@example.com" },
    entitlements: { modules: ["ml"], seller_modules: ["ml"] },
    subscription: {
      status: "active",
      active: true,
      expires_at: null,
      days_until_expiration: null,
      renewal_url: null,
      renewable_resources: [],
      is_master: true,
    },
  });
});
