"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createSellerPortalService } = require("../apps/gateway/services/sellerPortalService");

function response(payload, status = 200) {
  return { ok: status < 400, status, json: async () => payload };
}

test("platform master sees only Seller modules authorized by the Hub", async () => {
  const requests = [];
  const service = createSellerPortalService({
    baseUrl: "https://hub.example",
    internalToken: "test-token",
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      return response({ allow: body.module === "ml", reason: body.module === "ml" ? "platform_module_master" : "platform_module_not_allowed" });
    },
  });

  const result = await service.overview({
    tenant_id: "platform-master-ml",
    user_id: "master-ml",
    name: "Master ML",
    email: "master@example.com",
    subscription: { is_master: true },
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.platform_operator, true);
  assert.equal(result.payload.user.can_manage_billing, false);
  assert.deepEqual(result.payload.modules.map((module) => module.slug), ["ml"]);
  assert.equal(result.payload.modules[0].can_enter, true);
  assert.equal(result.payload.modules[0].can_purchase, false);
  assert.equal(requests.length, 7);
  assert.ok(requests.every(({ url, body }) => url.endsWith("/v1/access/check") &&
    body.tenant_id === "platform-master-ml" && body.user_id === "master-ml"));
});

test("platform overview fails closed if a Hub scope check fails", async () => {
  const service = createSellerPortalService({
    baseUrl: "https://hub.example",
    internalToken: "test-token",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      return body.module === "ml" ? response({ error: "hub_unavailable" }, 503) : response({ allow: false });
    },
  });
  const result = await service.overview({
    tenant_id: "platform-master-ml",
    user_id: "master-ml",
    subscription: { is_master: true },
  });
  assert.equal(result.status, 503);
  assert.equal(result.payload.error, "hub_unavailable");
});

test("customer portal continues to use the tenant overview", async () => {
  const requests = [];
  const service = createSellerPortalService({
    baseUrl: "https://hub.example",
    internalToken: "test-token",
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return response({ ok: true, modules: [] });
    },
  });
  const result = await service.overview({ tenant_id: "tenant-1", user_id: "user-1" });
  assert.equal(result.status, 200);
  assert.deepEqual(requests, [{
    url: "https://hub.example/v1/internal/portal/overview",
    body: { tenant_id: "tenant-1", user_id: "user-1" },
  }]);
});

test("postpaid invoice listing derives tenant identity from the signed-in portal session", async () => {
  const requests = [];
  const service = createSellerPortalService({
    baseUrl: "https://hub.example",
    internalToken: "test-token",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response({ ok: true, invoices: [] });
    },
  });

  const result = await service.postpaidInvoices({ tenant_id: "tenant-1", user_id: "user-1" });
  assert.equal(result.status, 200);
  assert.equal(requests[0].url, "https://hub.example/v1/internal/postpaid/invoices?tenant_id=tenant-1&user_id=user-1");
  assert.equal(requests[0].options.method, "GET");
  assert.equal(requests[0].options.headers.authorization, "Bearer test-token");
});
