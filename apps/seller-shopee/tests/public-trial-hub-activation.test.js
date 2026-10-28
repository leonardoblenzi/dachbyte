"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { activateShopeeTrialInHub } = require("../src/services/publicTrialHubActivation");

test("Shopee trial activation prepares identity, starts resource clock, then grants module access", async () => {
  const calls = [];
  const activation = { trial: { endsAt: "2099-01-01T00:00:00Z" }, resource: {
    resource_key: "shopee:123", tenant_id: "tenant-1", access_policy: "temporary",
  } };
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    const result = url.endsWith("/module-trials/activate") ? activation : {
      ok: true, tenant_id: "tenant-1", user_id: "user-1",
    };
    return { ok: true, json: async () => result };
  };
  const result = await activateShopeeTrialInHub({
    tenantId: "tenant-1", companyName: "Empresa", userId: "user-1",
    fullName: "Usuário", email: "user@example.com", shopId: "123", newIdentity: true,
    documentNumber: "11222333000181",
  }, { baseUrl: "https://hub.test", token: "internal", fetchImpl });
  assert.equal(result.resource.resource_key, "shopee:123");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].body.trial_prepare_identity, true);
  assert.equal(calls[1].body.module_slug, "shopee");
  assert.equal(calls[2].body.trial_prepare_identity, false);
  assert.equal(calls[0].body.reject_email_conflict, true);
});

test("Shopee trial distinguishes an unavailable CNPJ lookup", async () => {
  await assert.rejects(activateShopeeTrialInHub({
    tenantId: "tenant-1", companyName: "Empresa", userId: "user-1",
    fullName: "Usuário", email: "user@example.com", shopId: "123",
    newIdentity: true, documentNumber: "11222333000181",
  }, { baseUrl: "https://hub.test", token: "internal",
    fetchImpl: async () => ({ ok: false, status: 503,
      json: async () => ({ ok: false, error: "cnpj_lookup_unavailable" }) })
  }), /cnpj_lookup_unavailable/);
});
