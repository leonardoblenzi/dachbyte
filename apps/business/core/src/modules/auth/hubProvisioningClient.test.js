"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const originalFetch = global.fetch;
const originalBaseUrl = process.env.HUB_BASE_URL;
const originalToken = process.env.HUB_INTERNAL_TOKEN;

test.afterEach(() => {
  global.fetch = originalFetch;
  process.env.HUB_BASE_URL = originalBaseUrl;
  process.env.HUB_INTERNAL_TOKEN = originalToken;
});

test("provisions a Volt Core company through the internal Hub contract", async () => {
  process.env.HUB_BASE_URL = "https://hub.example";
  process.env.HUB_INTERNAL_TOKEN = "test-token";
  let request = null;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      ok: true,
      tenant_id: "tenant-hub-1",
      product_key: "volt_core",
      product_status: "active",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const client = require("./hubProvisioningClient");
  const result = await client.provisionVoltCoreCompany({
    idempotencyKey: "core-company-1",
    companyName: "Volt QA",
    documentType: "cnpj",
    documentNumber: "12345678000199",
  });

  assert.equal(request.url, "https://hub.example/v1/internal/identity/company");
  assert.equal(request.options.headers.authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(request.options.body), {
    idempotency_key: "core-company-1",
    company_name: "Volt QA",
    document_type: "cnpj",
    document_number: "12345678000199",
    module: "volt_core",
  });
  assert.equal(result.tenantId, "tenant-hub-1");
});

test("synchronizes a Volt Core user through the central invitation contract", async () => {
  process.env.HUB_BASE_URL = "https://hub.example";
  process.env.HUB_INTERNAL_TOKEN = "test-token";
  let request = null;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      ok: true,
      tenant_id: "tenant-hub-1",
      user_id: "user-hub-1",
      invite_url: "https://hub.example/convite?token=qa",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const client = require("./hubProvisioningClient");
  const result = await client.provisionVoltCoreUser({
    tenantId: "tenant-hub-1",
    companyName: "Volt QA",
    userId: "core-user-1",
    fullName: "Usuário QA",
    email: "qa@example.com",
    role: "operator",
  });

  assert.equal(request.url, "https://hub.example/v1/internal/identity/sync");
  assert.deepEqual(JSON.parse(request.options.body), {
    tenant_id: "tenant-hub-1",
    company_name: "Volt QA",
    user_id: "core-user-1",
    full_name: "Usuário QA",
    email: "qa@example.com",
    role: "operator",
    module: "volt_core",
    modules: ["volt_core"],
    access_policy: "explicit",
    invite: true,
    origin_module: "volt_core",
  });
  assert.deepEqual(result, {
    tenantId: "tenant-hub-1",
    userId: "user-hub-1",
    inviteUrl: "https://hub.example/convite?token=qa",
  });
});
