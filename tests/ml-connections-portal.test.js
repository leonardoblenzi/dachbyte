"use strict";

// Seleção de plataforma: contas do Mercado Livre da conexão única (gateway -> módulo ML).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createMlConnectionsPortalService } = require("../apps/gateway/services/mlConnectionsPortalService");

const identity = { tenant_id: "t-1", user_id: "u-1" };
const manager = { ok: true, status: 200, payload: { tenant: { name: "ACME" }, user: { can_manage_billing: true }, modules: [{ slug: "ml", installed: true }] } };

function setup({ overview = manager, responses = [] } = {}) {
  const calls = [];
  const queue = [...responses];
  const service = createMlConnectionsPortalService({
    connectionsUrl: "http://seller-ml-web:3000/ml/internal/connections",
    connectionsToken: "s3cret",
    portal: { overview: async () => overview },
    fetchImpl: async (url, init) => { calls.push({ url, init }); const r = queue.shift() || { ok: true }; return { ok: r.ok !== false, status: r.status || 200, json: async () => r }; },
  });
  return { service, calls };
}

test("lista só contas da empresa que ainda não estão no ML", async () => {
  const { service, calls } = setup({ responses: [{ ok: true, accounts: [
    { meli_user_id: 1, label: "No ML", connection: "ok", products: ["ml"] },
    { meli_user_id: 2, label: "Só Hub", connection: "ok", products: ["dach_hub"] },
    { meli_user_id: 3, label: "Sem produto", connection: "reconnect_required", products: [] },
  ] }] });
  const result = await service.dachbyteAccounts(identity);
  assert.equal(calls[0].url, "http://seller-ml-web:3000/ml/internal/connections/accounts?tenant_id=t-1");
  assert.equal(calls[0].init.headers.authorization, "Bearer s3cret");
  assert.deepEqual(result.payload.accounts.map((a) => a.meli_user_id), [2, 3]);
});

test("só quem gerencia a cobrança; sem o ML instalado segue (pode ganhar o teste de 7 dias)", async () => {
  const notManager = setup({ overview: { ...manager, payload: { ...manager.payload, user: { can_manage_billing: false } } } });
  assert.equal((await notManager.service.register(identity, { meli_user_id: 2 })).status, 403);
  assert.equal(notManager.calls.length, 0);
  const granted = [];
  const calls = [];
  const service = createMlConnectionsPortalService({
    connectionsUrl: "http://seller-ml-web:3000/ml/internal/connections", connectionsToken: "s3cret",
    portal: {
      overview: async () => ({ ...manager, payload: { ...manager.payload, user: { can_manage_billing: true, name: "Ana", email: "ana@x.com", role: "owner" }, modules: [] } }),
      grantModuleAccess: async (_identity, input) => { granted.push(input); return { ok: true }; },
    },
    fetchImpl: async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ ok: true, url: "https://auth" }) }; },
  });
  const result = await service.connect(identity, { publicOrigin: "https://dachbyte.tech" });
  assert.equal(result.ok, true);
  assert.deepEqual(granted, [{ module: "ml", tenantName: "ACME", userName: "Ana", userEmail: "ana@x.com", userRole: "owner" }], "quem adiciona a conta passa a poder entrar no ML");
  assert.equal((await setup().service.dachbyteAccounts({})).status, 401);
});

test("registrar e conectar vão para o módulo ML com a empresa da sessão", async () => {
  const { service, calls } = setup({ responses: [{ ok: true, resource_key: "ml:2" }, { ok: true, url: "https://auth.mercadolivre.com.br/x" }] });
  assert.equal((await service.register(identity, { meli_user_id: "2" })).payload.resource_key, "ml:2");
  assert.deepEqual(JSON.parse(calls[0].init.body), { tenant_id: "t-1", meli_user_id: 2 });
  await service.connect(identity, { publicOrigin: "https://dachbyte.tech" });
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    tenant_id: "t-1", user_global_id: "u-1", company_name: "ACME", product: "none", return_to: "/selecao-plataforma", public_origin: "https://dachbyte.tech",
  });
  assert.equal((await service.register(identity, { meli_user_id: "abc" })).status, 400);
});

test("gateway expõe as três rotas com sessão da suíte", () => {
  const server = fs.readFileSync(path.join(__dirname, "../apps/gateway/server.js"), "utf8");
  for (const route of ['app.get("/api/portal/ml/dachbyte-accounts"', 'app.post("/api/portal/ml/register"', 'app.post("/api/portal/ml/connect"']) {
    const at = server.indexOf(route);
    assert.ok(at > 0, route);
    assert.match(server.slice(at, at + 400), /readSuitePayload\(req\)[\s\S]*status\(401\)/);
  }
});
