"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateHubLoginAccess } = require("../src/services/hubAccessService");

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload || {}),
  };
}

function withHubEnv(callback) {
  const previous = {
    HUB_BASE_URL: process.env.HUB_BASE_URL,
    HUB_INTERNAL_TOKEN: process.env.HUB_INTERNAL_TOKEN,
    HUB_AUTH_MODE: process.env.HUB_AUTH_MODE,
    HUB_ENFORCEMENT: process.env.HUB_ENFORCEMENT,
  };

  process.env.HUB_BASE_URL = "https://hub.test";
  process.env.HUB_INTERNAL_TOKEN = "test-token";
  delete process.env.HUB_AUTH_MODE;
  delete process.env.HUB_ENFORCEMENT;

  return Promise.resolve()
    .then(callback)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

test("modo padrao hybrid nao bloqueia login por conta local incompleta", async () => {
  await withHubEnv(async () => {
    const result = await evaluateHubLoginAccess({
      user: {
        id: 10,
        name: "Cliente Teste",
        email: "cliente@teste.com",
      },
      account: null,
      role: "member",
    });

    assert.equal(result.allow, true);
    assert.equal(result.reason, "identity_account_missing");
  });
});

test("modo padrao hybrid respeita bloqueio explicito do Hub para o modulo Shopee", async () => {
  await withHubEnv(async () => {
    const previousFetch = global.fetch;
    const requests = [];
    global.fetch = async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(options.body) });
      if (String(url).endsWith("/v1/internal/identity/sync")) {
        return jsonResponse(200, {
          tenant_id: "tenant_1",
          user_id: "shopee_user_10",
        });
      }
      return jsonResponse(200, {
        allow: false,
        reason: "user_module_not_allowed",
        message: "Usuario sem acesso liberado para este modulo.",
      });
    };

    try {
      const result = await evaluateHubLoginAccess({
        user: {
          id: 10,
          name: "Cliente Teste",
          email: "cliente@teste.com",
          role: "member",
        },
        account: {
          id: 20,
          name: "Empresa Teste",
          tenantGlobalId: "tenant_1",
        },
      });

      assert.equal(result.allow, false);
      assert.equal(result.reason, "user_module_not_allowed");
      assert.equal(requests.length, 2);
      assert.equal(requests[1].body.module, "shopee");
      assert.equal(requests[1].body.action, "login");
    } finally {
      global.fetch = previousFetch;
    }
  });
});
