"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  revokeHubModuleAccess,
  syncHubIdentity,
} = require("./hubIdentitySync");

function withHubEnvironment(run) {
  const previousBaseUrl = process.env.HUB_BASE_URL;
  const previousToken = process.env.HUB_INTERNAL_TOKEN;
  const previousFetch = global.fetch;
  process.env.HUB_BASE_URL = "https://hub.example.test";
  process.env.HUB_INTERNAL_TOKEN = "test-token";
  return Promise.resolve()
    .then(run)
    .finally(() => {
      process.env.HUB_BASE_URL = previousBaseUrl;
      process.env.HUB_INTERNAL_TOKEN = previousToken;
      global.fetch = previousFetch;
    });
}

test("sincronizacao encaminha modulo e intencao explicita", async () => {
  await withHubEnvironment(async () => {
    let request = null;
    global.fetch = async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const result = await syncHubIdentity({
      tenant_id: "tenant-1",
      company_name: "Empresa",
      user_id: "user-1",
      full_name: "Usuario",
      email: "usuario@empresa.com",
      module: "shopee",
      modules: ["shopee"],
      access_policy: "explicit",
    });

    assert.equal(result.ok, true);
    assert.equal(request.url, "https://hub.example.test/v1/internal/identity/sync");
    const payload = JSON.parse(request.options.body);
    assert.equal(payload.module, "shopee");
    assert.deepEqual(payload.modules, ["shopee"]);
    assert.equal(payload.access_policy, "explicit");
  });
});

test("revogacao usa endpoint por modulo", async () => {
  await withHubEnvironment(async () => {
    let request = null;
    global.fetch = async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const result = await revokeHubModuleAccess({
      tenant_id: "tenant-1",
      user_id: "user-1",
      email: "usuario@empresa.com",
      module: "tracking",
    });

    assert.equal(result.ok, true);
    assert.equal(
      request.url,
      "https://hub.example.test/v1/internal/identity/module-access/revoke",
    );
    const payload = JSON.parse(request.options.body);
    assert.equal(payload.module, "tracking");
    assert.equal(payload.user_id, "user-1");
  });
});
