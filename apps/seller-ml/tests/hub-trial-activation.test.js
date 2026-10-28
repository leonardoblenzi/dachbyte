"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { activateMlTrialInHub } = require("../services/hubTrialActivation");

const identity = {
  tenantId: "company-1", companyName: "Loja Exemplo",
  userId: "user-1", fullName: "Pessoa Exemplo", email: "owner@example.test",
  mlUserId: 123, documentNumber: "11222333000181"
};

test("activation prepares identity, provisions resource, then grants ML access", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), authorization: options.headers.authorization });
    const payload = calls.length === 2
      ? { trial: { endsAt: "2026-10-27T12:00:00.000Z" }, resource: { resource_key: "ml:123" } }
      : { ok: true, tenant_id: "company-1", user_id: "user-1" };
    return { ok: true, status: 200, json: async () => payload };
  };
  await activateMlTrialInHub(identity, {
    baseUrl: "https://hub.example", token: "internal", fetchImpl
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://hub.example/v1/internal/identity/sync");
  assert.equal(calls[0].body.access_policy, "explicit");
  assert.equal(calls[0].body.trial_prepare_identity, true);
  assert.equal(calls[0].body.reject_email_conflict, false);
  assert.deepEqual(calls[0].body.modules, ["ml"]);
  assert.equal(calls[1].url, "https://hub.example/v1/internal/portal/module-trials/activate");
  assert.equal(calls[1].body.resource_key, "ml:123");
  assert.equal(calls[1].authorization, "Bearer internal");
  assert.equal(calls[2].url, "https://hub.example/v1/internal/identity/sync");
  assert.equal(calls[2].body.trial_prepare_identity, false);
});

test("existing company membership retains its actual role during trial sync", async () => {
  const calls = [];
  await activateMlTrialInHub({ ...identity, role: "admin" }, {
    baseUrl: "https://hub.example", token: "internal",
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true, json: async () => calls.length === 2
        ? { trial: { endsAt: "2026-10-27T12:00:00.000Z" }, resource: { resource_key: "ml:123" } }
        : { ok: true, tenant_id: "company-1", user_id: "user-1" } };
    }
  });
  assert.equal(calls[0].role, "admin");
});

test("new company identity requires strict Hub email ownership", async () => {
  const calls = [];
  await activateMlTrialInHub({ ...identity, newIdentity: true }, {
    baseUrl: "https://hub.example", token: "internal",
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true, json: async () => calls.length === 2
        ? { trial: { endsAt: "2026-10-27T12:00:00.000Z" }, resource: { resource_key: "ml:123" } }
        : { ok: true, tenant_id: "company-1", user_id: "user-1" } };
    }
  });
  assert.equal(calls[0].reject_email_conflict, true);
});

test("ML trial keeps a CNPJ-not-found response actionable", async () => {
  await assert.rejects(activateMlTrialInHub({ ...identity, newIdentity: true }, {
    baseUrl: "https://hub.example", token: "internal",
    fetchImpl: async () => ({ ok: false, status: 400,
      json: async () => ({ ok: false, error: "cnpj_not_found" }) })
  }), /cnpj_not_found/);
});

test("activation fails closed when identity sync or resource activation is not confirmed", async () => {
  let calls = 0;
  await assert.rejects(activateMlTrialInHub(identity, {
    baseUrl: "https://hub.example", token: "internal",
    fetchImpl: async () => {
      calls++;
      return { ok: false, status: 503, json: async () => ({ ok: false }) };
    }
  }), /trial_hub_identity_sync_failed/);
  assert.equal(calls, 1);
  await assert.rejects(activateMlTrialInHub(identity, {
    baseUrl: "https://hub.example", token: "internal",
    fetchImpl: async () => {
      calls++;
      return calls === 2
        ? { ok: true, status: 200, json: async () => ({ ok: true, tenant_id: "company-1", user_id: "user-1" }) }
        : { ok: false, status: 409, json: async () => ({ ok: false }) };
    }
  }), /trial_hub_resource_activation_failed/);
});

test("local activation remains pending when final module grant fails after resource creation", async () => {
  let calls = 0;
  await assert.rejects(activateMlTrialInHub(identity, {
    baseUrl: "https://hub.example", token: "internal",
    fetchImpl: async () => {
      calls++;
      if (calls === 2) return { ok: true, json: async () => ({
        trial: { endsAt: "2026-10-27T12:00:00.000Z" }, resource: { resource_key: "ml:123" }
      }) };
      return calls === 1
        ? { ok: true, json: async () => ({ ok: true, tenant_id: "company-1", user_id: "user-1" }) }
        : { ok: false, json: async () => ({ ok: false }) };
    }
  }), /trial_hub_module_access_failed/);
  assert.equal(calls, 3);
});

test("a concurrent global email collision cannot activate a trial for a different user", async () => {
  let calls = 0;
  await assert.rejects(activateMlTrialInHub(identity, {
    baseUrl: "https://hub.example", token: "internal",
    fetchImpl: async () => {
      calls++;
      return { ok: true, status: 200,
        json: async () => ({ ok: true, tenant_id: "company-1", user_id: "someone-else" }) };
    }
  }), /trial_hub_identity_mismatch/);
  assert.equal(calls, 1);
});
