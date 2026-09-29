"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateHubLoginAccess } = require("../services/hubAccessService");

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload || {}),
  };
}

function withHubEnv(callback, overrides = {}) {
  const keys = [
    "HUB_BASE_URL",
    "HUB_INTERNAL_TOKEN",
    "HUB_AUTH_MODE",
    "HUB_ENFORCEMENT",
    "NODE_ENV",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  process.env.HUB_BASE_URL = "https://hub.test";
  process.env.HUB_INTERNAL_TOKEN = "test-token";
  delete process.env.HUB_AUTH_MODE;
  delete process.env.HUB_ENFORCEMENT;
  process.env.NODE_ENV = "test";

  for (const [key, value] of Object.entries(overrides)) {
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }

  return Promise.resolve()
    .then(callback)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function validInput() {
  return {
    user: {
      id: 10,
      name: "Cliente Teste",
      email: "cliente@teste.com",
      user_global_id: "user_1",
    },
    company: {
      empresa_id: 20,
      company_name: "Empresa Teste",
      tenant_global_id: "tenant_1",
    },
    role: "member",
  };
}

test("fora de producao o modo padrao hybrid nao bloqueia identidade local incompleta", async () => {
  await withHubEnv(async () => {
    const result = await evaluateHubLoginAccess({
      user: { id: 10, name: "Cliente Teste", email: "cliente@teste.com" },
      company: null,
      role: "member",
    });

    assert.equal(result.allow, true);
    assert.equal(result.reason, "identity_company_missing");
  });
});

test("modo hybrid respeita bloqueio explicito do Hub para o modulo ML", async () => {
  await withHubEnv(async () => {
    const previousFetch = global.fetch;
    const requests = [];
    global.fetch = async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(options.body) });
      if (String(url).endsWith("/v1/internal/identity/sync")) {
        return jsonResponse(200, { tenant_id: "tenant_1", user_id: "user_1" });
      }
      return jsonResponse(200, {
        allow: false,
        reason: "user_module_not_allowed",
        message: "Usuario sem acesso liberado para este modulo.",
      });
    };

    try {
      const result = await evaluateHubLoginAccess(validInput());
      assert.equal(result.allow, false);
      assert.equal(result.reason, "user_module_not_allowed");
      assert.equal(requests.length, 2);
      assert.equal(requests[1].body.module, "ml");
      assert.equal(requests[1].body.action, "login");
    } finally {
      global.fetch = previousFetch;
    }
  });
});

test("401 do sync do Hub nunca vira bypass", async () => {
  await withHubEnv(async () => {
    const previousFetch = global.fetch;
    global.fetch = async () => jsonResponse(401, { error: "unauthorized" });
    try {
      const result = await evaluateHubLoginAccess(validInput());
      assert.equal(result.allow, false);
      assert.equal(result.reason, "hub_auth_invalid");
      assert.equal(result.status, 401);
    } finally {
      global.fetch = previousFetch;
    }
  }, { HUB_AUTH_MODE: "hybrid" });
});

test("403 do access check do Hub nunca vira bypass", async () => {
  await withHubEnv(async () => {
    const previousFetch = global.fetch;
    let call = 0;
    global.fetch = async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse(200, { tenant_id: "tenant_1", user_id: "user_1" });
      }
      return jsonResponse(403, { error: "forbidden" });
    };
    try {
      const result = await evaluateHubLoginAccess(validInput());
      assert.equal(result.allow, false);
      assert.equal(result.reason, "hub_auth_invalid");
      assert.equal(result.status, 403);
    } finally {
      global.fetch = previousFetch;
    }
  }, { HUB_AUTH_MODE: "hybrid" });
});

test("producao usa strict por padrao e bloqueia identidade incompleta", async () => {
  await withHubEnv(async () => {
    const result = await evaluateHubLoginAccess({
      user: { id: 10, name: "Cliente", email: "cliente@teste.com" },
      company: null,
      role: "member",
    });
    assert.equal(result.allow, false);
    assert.equal(result.reason, "identity_company_missing");
  }, { NODE_ENV: "production" });
});

test("strict bloqueia quando Hub obrigatorio nao esta configurado", async () => {
  await withHubEnv(async () => {
    const result = await evaluateHubLoginAccess(validInput());
    assert.equal(result.allow, false);
    assert.equal(result.reason, "hub_not_configured");
  }, {
    NODE_ENV: "production",
    HUB_AUTH_MODE: "strict",
    HUB_BASE_URL: null,
    HUB_INTERNAL_TOKEN: null,
  });
});
