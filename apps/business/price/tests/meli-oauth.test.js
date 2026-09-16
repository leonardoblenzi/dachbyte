"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createMeliConnectHandler, createMeliCallbackHandler } = require("../src/routes/integrations.routes");

function request({ query = {}, vpAuth = { tenantId: "t-1", userId: "u-1" } } = {}) {
  return { query, vpAuth };
}

function response() {
  return {
    body: null,
    redirectedTo: null,
    json(body) { this.body = body; return this; },
    redirect(location) { this.redirectedTo = location; return this; },
  };
}

async function invoke(handler, req) {
  const res = response();
  await handler(req, res);
  return { res };
}

test("connect ML associa o verifier PKCE ao estado e envia apenas o challenge ao provedor", async () => {
  let stateInput;
  let authorizationInput;
  const handler = createMeliConnectHandler({
    pkce: () => ({ verifier: "pkce-verifier-secret", challenge: "pkce-challenge" }),
    createOAuthState: async (...args) => { stateInput = args; return "opaque-state"; },
    buildAuthUrl: (...args) => { authorizationInput = args; return "https://auth.mercadolivre.com/authorization?state=opaque-state&code_challenge=pkce-challenge"; },
  });

  const { res } = await invoke(handler, request());

  assert.deepEqual(stateInput, [{ tenantId: "t-1", userId: "u-1" }, "meli", { verifier: "pkce-verifier-secret" }]);
  assert.equal(authorizationInput[1], "opaque-state");
  assert.equal(authorizationInput[2], "pkce-challenge");
  assert.doesNotMatch(JSON.stringify(res.body), /pkce-verifier-secret/);
});

test("callback ML persiste uma conex\u00e3o por user_id e redireciona sem tokens", async () => {
  const stored = [];
  const audits = [];
  const handler = createMeliCallbackHandler({
    consumeOAuthState: async () => ({ tenant_id: "t-1", user_id: "u-1", payload: { verifier: "v" } }),
    exchangeCode: async () => ({ access_token: "secret-a", refresh_token: "secret-r", user_id: 987, expires_in: 21600 }),
    withTenant: async (_tenant, _user, work) => work({}),
    upsertConnection: async (_db, _tenant, channel, value) => stored.push({ channel, value }),
    audit: async (_db, event) => audits.push(event),
  });

  const { res } = await invoke(handler, request({ query: { state: "opaque", code: "provider-code" } }));

  assert.equal(res.redirectedTo, "/business/price/app/integrations?connected=meli");
  assert.equal(stored[0].value.externalAccountId, "987");
  assert.doesNotMatch(JSON.stringify({ res, stored: [] }), /secret-a|secret-r|provider-code/);
  assert.doesNotMatch(JSON.stringify(audits), /secret-a|secret-r|provider-code/);
});

test("callback ML aceita cada estado OAuth uma \u00fanica vez", async () => {
  let consumes = 0;
  let exchanges = 0;
  const handler = createMeliCallbackHandler({
    consumeOAuthState: async () => (++consumes === 1 ? { tenant_id: "t-1", user_id: "u-1", payload: { verifier: "v" } } : null),
    exchangeCode: async () => { exchanges += 1; return { access_token: "a", refresh_token: "r", user_id: 987 }; },
    withTenant: async (_tenant, _user, work) => work({}),
    upsertConnection: async () => {},
    audit: async () => {},
  });

  const first = await invoke(handler, request({ query: { state: "opaque", code: "provider-code" } }));
  const second = await invoke(handler, request({ query: { state: "opaque", code: "provider-code" } }));

  assert.equal(first.res.redirectedTo, "/business/price/app/integrations?connected=meli");
  assert.equal(second.res.redirectedTo, "/business/price/app/integrations?meli=error");
  assert.equal(exchanges, 1);
});

for (const field of ["access_token", "refresh_token", "user_id"]) {
  test(`callback ML rejeita resposta sem ${field}`, async () => {
    let persisted = false;
    const data = { access_token: "access", refresh_token: "refresh", user_id: 987 };
    delete data[field];
    const handler = createMeliCallbackHandler({
      consumeOAuthState: async () => ({ tenant_id: "t-1", user_id: "u-1", payload: { verifier: "v" } }),
      exchangeCode: async () => data,
      withTenant: async (_tenant, _user, work) => work({}),
      upsertConnection: async () => { persisted = true; },
      audit: async () => {},
    });

    const { res } = await invoke(handler, request({ query: { state: "opaque", code: "provider-code" } }));

    assert.equal(res.redirectedTo, "/business/price/app/integrations?meli=error");
    assert.equal(persisted, false);
  });
}

test("callback ML inv\u00e1lido redireciona para erro gen\u00e9rico", async () => {
  const { res } = await invoke(createMeliCallbackHandler({ consumeOAuthState: async () => null }), request());
  assert.equal(res.redirectedTo, "/business/price/app/integrations?meli=error");
});
