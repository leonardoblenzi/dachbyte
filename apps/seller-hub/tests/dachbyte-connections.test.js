"use strict";

// Conexão única da DACHBYTE no Hub: Mercado Livre com contas e chaves no módulo ML.
const test = require("node:test");
const assert = require("node:assert/strict");
const { sha256 } = require("../src/platform/crypto");
const { createAccountsService, TokenManager } = require("../src/modules/accounts/service");
const { createDachbyteConnections } = require("../src/platform/dachbyteConnections");
const { createOrdersService } = require("../src/modules/orders/service");
const { createConnectors } = require("../src/connectors/registry");
const { loadConfig } = require("../src/platform/config");

/** Módulo ML falso (dono das contas): contas por empresa com produtos. */
function fakeBroker(initial = []) {
  const accounts = initial.map((a) => ({ connection: "ok", products: [], ...a }));
  const calls = [];
  return {
    accounts, calls, configured: true,
    async listAccounts(tenantId) { calls.push(["list", tenantId]); return accounts.filter((a) => a.tenant === tenantId).map(({ tenant, ...a }) => ({ ...a, products: [...a.products] })); },
    async authorize(input) { calls.push(["authorize", input]); return `https://auth.mercadolivre.com.br/authorization?state=x&return=${encodeURIComponent(input.returnTo)}`; },
    async token(input) { calls.push(["token", input]); return { accessToken: input.rejectedAccessToken ? "AT-NEW" : "AT-1", expiresAt: new Date(Date.now() + 6 * 3600 * 1000) }; },
    async activate({ tenantId, externalAccountId }) {
      calls.push(["activate", externalAccountId]);
      const a = accounts.find((x) => x.tenant === tenantId && String(x.meli_user_id) === externalAccountId);
      a.products = [...new Set([...a.products, "dach_hub"])];
      return { meli_user_id: a.meli_user_id, label: a.label, connection: a.connection, products: a.products };
    },
    async deactivate({ externalAccountId }) { calls.push(["deactivate", externalAccountId]); },
  };
}

/** Repositório em memória com o que o serviço de contas usa. */
function fakeRepository() {
  const accounts = [], links = [], audits = [];
  let nextId = 1;
  return {
    accounts, links, audits,
    async usage(tenantId) {
      const map = {};
      for (const a of accounts) if (a.tenantId === tenantId && a.status !== "disconnected") map[a.channel] = (map[a.channel] || 0) + 1;
      return Object.entries(map).map(([channel, n]) => ({ channel, accounts: n }));
    },
    async findActiveByExternal(tenantId, channel, ext) { return accounts.find((a) => a.tenantId === tenantId && a.channel === channel && a.externalAccountId === ext && a.status !== "disconnected") || null; },
    async findTenantAccount(tenantId, id) { return accounts.find((a) => a.tenantId === tenantId && a.id === id && a.status !== "disconnected") || null; },
    async channelAccounts(tenantId, channel) { return accounts.filter((a) => a.tenantId === tenantId && a.channel === channel); },
    async upsertAccount({ tenantId, channel, externalAccountId, label, connectionSource = "own", status = "connected" }) {
      let a = accounts.find((x) => x.channel === channel && x.externalAccountId === externalAccountId);
      if (a && a.tenantId !== tenantId) return null;
      const created = !a;
      if (!a) { a = { id: nextId++, tenantId, channel, externalAccountId, label }; accounts.push(a); }
      Object.assign(a, { status, connectionSource });
      return { ...a, created };
    },
    async setStatus(id, status) { const a = accounts.find((x) => x.id === id); if (a && a.status !== "disconnected") a.status = status; },
    async audit(e) { audits.push(e); },
    async disconnect(tenantId, id) { const a = accounts.find((x) => x.tenantId === tenantId && x.id === id); if (!a) return null; a.status = "disconnected"; return { id }; },
    async createLink(l) { const row = { id: nextId++, ...l, createdBy: l.userId, expiresAt: new Date(Date.now() + l.ttlSeconds * 1000).toISOString(), openedAt: null, usedAt: null, cancelledAt: null }; links.push(row); return { id: row.id, channel: l.channel, expiresAt: row.expiresAt }; },
    async findLink(hash) { return links.find((l) => l.tokenHash === hash) || null; },
    async claimLink(id) { const l = links.find((x) => x.id === id); if (!l || l.openedAt) return null; l.openedAt = new Date().toISOString(); return { id }; },
    async completeLink(id, accountId) { const l = links.find((x) => x.id === id); if (!l || l.usedAt) return null; l.usedAt = new Date().toISOString(); l.accountId = accountId; return { id }; },
  };
}

/** Canais reais (o app próprio do Hub no ML não está configurado). */
const connectors = createConnectors({});

function setup({ broker = fakeBroker(), accountLimit = null } = {}) {
  const repository = fakeRepository();
  const service = createAccountsService({
    repository, connectors, cipher: { encrypt: (v) => v, decrypt: (v) => v }, publicBaseUrl: "https://dachbyte.tech/hub", brokers: { mercadolivre: broker },
  });
  const admin = { tenantId: "t-1", userId: "u-1", companyName: "ACME", accountLimit };
  return { repository, service, broker, admin };
}

test("cliente da conexão: token entre serviços, rotas e erros traduzidos", async () => {
  const requests = [];
  const responses = [
    { status: 200, body: { ok: true, accounts: [{ meli_user_id: 5 }] } },
    { status: 200, body: { ok: true, access_token: "AT", expires_at: "2026-11-10T10:00:00Z" } },
    { status: 409, body: { ok: false, error: "reconnect_required" } },
    { status: 500, body: { ok: false, error: "connections_failed" } },
  ];
  const client = createDachbyteConnections({
    baseUrl: "http://seller-ml-web:3000/ml/internal/connections/", token: "s3cret",
    fetchImpl: async (url, init) => { requests.push({ url, init }); const r = responses.shift(); return { ok: r.status < 400, status: r.status, json: async () => r.body }; },
  });
  assert.deepEqual(await client.listAccounts("t 1"), [{ meli_user_id: 5 }]);
  assert.equal(requests[0].url, "http://seller-ml-web:3000/ml/internal/connections/accounts?tenant_id=t%201");
  assert.equal(requests[0].init.headers.authorization, "Bearer s3cret");
  const token = await client.token({ tenantId: "t-1", externalAccountId: "555", rejectedAccessToken: "OLD" });
  assert.equal(token.accessToken, "AT");
  assert.deepEqual(JSON.parse(requests[1].init.body), { tenant_id: "t-1", product: "dach_hub", meli_user_id: 555, rejected_access_token: "OLD" });
  await assert.rejects(client.token({ tenantId: "t-1", externalAccountId: "555" }), { code: "reconnect_required", status: 409 });
  await assert.rejects(client.listAccounts("t-1"), { status: 503 });
  assert.equal(createDachbyteConnections({ baseUrl: "", token: "x" }).configured, false);
});

test("config: Mercado Livre usa a conexão DACHBYTE só com URL e token", () => {
  const off = loadConfig({});
  assert.deepEqual(off.dachbyteConnections.mercadolivre, { baseUrl: "", token: "" });
  const on = loadConfig({ HUB_ML_CONNECTIONS_URL: "http://seller-ml-web:3000/ml/internal/connections", SELLER_CONNECTIONS_TOKEN: "k" });
  assert.equal(on.dachbyteConnections.mercadolivre.token, "k");
  assert.equal(on.internalToken, "k");
});

test("cartão do Mercado Livre fica disponível pela conexão DACHBYTE", () => {
  const { service } = setup();
  const ml = service.channels().find((c) => c.id === "mercadolivre");
  assert.equal(ml.available, true);
  assert.equal(ml.connection, "dachbyte");
  const shopee = service.channels().find((c) => c.id === "shopee");
  assert.equal(shopee.connection, "own");
});

test("conectar: autoriza pelo módulo ML, volta para /hub/contas e respeita o limite", async () => {
  const { service, broker, admin, repository } = setup({ accountLimit: 1 });
  const url = await service.startConnect({ identity: admin, channel: "mercadolivre" });
  assert.match(url, /^https:\/\/auth\.mercadolivre\.com\.br/);
  const [, input] = broker.calls.find((c) => c[0] === "authorize");
  assert.deepEqual(input, { tenantId: "t-1", userId: "u-1", companyName: "ACME", returnTo: "/hub/contas", publicOrigin: "https://dachbyte.tech" });
  repository.accounts.push({ id: 99, tenantId: "t-1", channel: "shopee", externalAccountId: "s1", status: "connected" });
  await assert.rejects(service.startConnect({ identity: admin, channel: "mercadolivre" }), { code: "account_limit_reached" });
  // Reconectar uma conta da empresa não gasta vaga.
  await service.startConnect({ identity: admin, channel: "mercadolivre", reconnectAccountId: 99 });
});

test("sincronizar: traz contas ativas no Hub, lista as do ML para importar e atualiza a situação", async () => {
  const broker = fakeBroker([
    { tenant: "t-1", meli_user_id: 111, label: "Loja ML", products: ["ml"] },
    { tenant: "t-1", meli_user_id: 222, label: "Loja Hub", products: ["dach_hub"] },
    { tenant: "t-1", meli_user_id: 333, label: "Perdida", products: ["dach_hub"], connection: "reconnect_required" },
    { tenant: "t-2", meli_user_id: 444, label: "Outra empresa", products: ["dach_hub"] },
  ]);
  const { service, repository, admin } = setup({ broker });
  const first = await service.syncDachbyte(admin);
  assert.deepEqual(first.added.map((a) => a.externalAccountId).sort(), ["222", "333"]);
  assert.deepEqual(first.available, [{ channel: "mercadolivre", externalAccountId: "111", label: "Loja ML", connection: "ok" }]);
  assert.deepEqual(repository.accounts.map((a) => [a.externalAccountId, a.status, a.connectionSource]), [["222", "connected", "dachbyte"], ["333", "reconnect_required", "dachbyte"]]);
  // Reconectou no ML: a situação no Hub acompanha; nada é recriado.
  broker.accounts[2].connection = "ok";
  const second = await service.syncDachbyte(admin);
  assert.equal(second.added.length, 0);
  assert.equal(repository.accounts.find((a) => a.externalAccountId === "333").status, "connected");
  // Desconectada no Hub não volta sozinha.
  repository.accounts.find((a) => a.externalAccountId === "222").status = "disconnected";
  await service.syncDachbyte(admin);
  assert.equal(repository.accounts.find((a) => a.externalAccountId === "222").status, "disconnected");
});

test("importar conta do módulo ML no Hub: sem nova autorização, com vaga no plano", async () => {
  const broker = fakeBroker([{ tenant: "t-1", meli_user_id: 111, label: "Loja ML", products: ["ml"] }]);
  const { service, repository, admin } = setup({ broker, accountLimit: 1 });
  const stored = await service.importAccount({ identity: admin, channel: "mercadolivre", externalAccountId: "111" });
  assert.equal(stored.connectionSource, "dachbyte");
  assert.deepEqual(broker.calls.filter((c) => c[0] === "activate"), [["activate", "111"]]);
  assert.ok(!broker.calls.some((c) => c[0] === "authorize"), "não pede nova autorização ao marketplace");
  assert.ok(repository.audits.some((e) => e.action === "account_imported"));
  await assert.rejects(service.importAccount({ identity: admin, channel: "mercadolivre", externalAccountId: "abc" }), { code: "invalid_account" });
  await assert.rejects(service.importAccount({ identity: admin, channel: "shopee", externalAccountId: "1" }), { code: "not_dachbyte_channel" });
  broker.accounts.push({ tenant: "t-1", meli_user_id: 222, label: "Outra", products: ["ml"], connection: "ok" });
  await assert.rejects(service.importAccount({ identity: admin, channel: "mercadolivre", externalAccountId: "222" }), { code: "account_limit_reached" });
});

test("desconectar conta DACHBYTE: tira do Hub no módulo antes de marcar aqui", async () => {
  const broker = fakeBroker([{ tenant: "t-1", meli_user_id: 222, label: "Loja Hub", products: ["dach_hub"] }]);
  const { service, repository, admin } = setup({ broker });
  const [account] = (await service.syncDachbyte(admin)).added;
  await service.disconnect({ identity: admin, accountId: account.id });
  assert.deepEqual(broker.calls.filter((c) => c[0] === "deactivate"), [["deactivate", "222"]]);
  assert.equal(repository.accounts[0].status, "disconnected");
  // Módulo fora do ar: não marca como desconectada (senão voltaria na próxima sincronização).
  const down = fakeBroker([{ tenant: "t-1", meli_user_id: 333, label: "X", products: ["dach_hub"] }]);
  down.deactivate = async () => { throw Object.assign(new Error("connections_unavailable"), { status: 503, code: "connections_unavailable" }); };
  const other = setup({ broker: down });
  const [acc] = (await other.service.syncDachbyte(other.admin)).added;
  await assert.rejects(other.service.disconnect({ identity: other.admin, accountId: acc.id }), { code: "connections_unavailable" });
  assert.equal(other.repository.accounts[0].status, "connected");
});

test("link de autorização pela conexão DACHBYTE: volta para a página pública do link e entra na empresa certa", async () => {
  const broker = fakeBroker();
  const { service, repository, admin } = setup({ broker });
  const link = await service.createLink({ identity: admin, channel: "mercadolivre" });
  const token = link.url.split("/conectar/")[1];
  await service.startLink(token);
  const [, input] = broker.calls.find((c) => c[0] === "authorize");
  assert.equal(input.returnTo, `/hub/conectar/${token}/concluido`);
  assert.equal(input.tenantId, "t-1");
  // Sem a conta ativa no Hub na DACHBYTE, nada entra.
  await assert.rejects(service.finishBrokeredLink({ token, externalAccountId: "777" }), { code: "authorization_incomplete" });
  broker.accounts.push({ tenant: "t-1", meli_user_id: 777, label: "Sócio", products: ["dach_hub"], connection: "ok" });
  const done = await service.finishBrokeredLink({ token, externalAccountId: "777" });
  assert.equal(done.account.externalAccountId, "777");
  assert.equal(repository.links[0].usedAt != null, true);
  await assert.rejects(service.finishBrokeredLink({ token, externalAccountId: "777" }), { code: "link_unavailable" }, "uso único");
  assert.equal(repository.links[0].tokenHash, sha256(token));
});

test("chave da conta DACHBYTE: pedida ao módulo, guardada até perto de vencer, sem renovar no Hub", async () => {
  const broker = fakeBroker();
  const status = [];
  const own = [];
  const repository = {
    async connectionSource(id) { return id === 1 ? { id: 1, tenantId: "t-1", channel: "mercadolivre", externalAccountId: "222", status: "reconnect_required", connectionSource: "dachbyte" } : { id, connectionSource: "own" }; },
    async setStatus(id, s) { status.push([id, s]); },
    async withTokenLock(id, work) { own.push(id); return work({ client: null, row: { id, channel: "shopee", externalAccountId: "s", status: "connected", accessTokenEnc: "OWN", expiresAt: null } }); },
  };
  const tokens = new TokenManager({ repository, connectors, cipher: { encrypt: (v) => v, decrypt: (v) => v }, brokers: { mercadolivre: broker } });
  assert.deepEqual(await tokens.getAccessToken(1), { accessToken: "AT-1", externalAccountId: "222", channel: "mercadolivre" });
  assert.deepEqual(status, [[1, "connected"]], "conta volta a conectada quando o módulo entrega a chave");
  await tokens.getAccessToken(1);
  assert.equal(broker.calls.filter((c) => c[0] === "token").length, 1, "segunda chamada usa a chave guardada");
  assert.equal((await tokens.getAccessToken(1, { rejectedAccessToken: "AT-1" })).accessToken, "AT-NEW");
  assert.equal(broker.calls.filter((c) => c[0] === "token").at(-1)[1].rejectedAccessToken, "AT-1");
  assert.equal((await tokens.getAccessToken(2)).accessToken, "OWN", "conexão própria segue no Hub");
  assert.deepEqual(own, [2]);

  broker.token = async () => { throw Object.assign(new Error("reconnect_required"), { status: 409, code: "reconnect_required" }); };
  tokens.brokeredCache.clear();
  await assert.rejects(tokens.getAccessToken(1), { code: "reconnect_required" });
  assert.deepEqual(status.at(-1), [1, "reconnect_required"]);
  broker.token = async () => { throw Object.assign(new Error("connections_unavailable"), { status: 503, code: "connections_unavailable" }); };
  const before = status.length;
  await assert.rejects(tokens.getAccessToken(1), { code: "connections_unavailable" });
  assert.equal(status.length, before, "queda do módulo não marca a conta para reconectar");
});

test("aviso repassado pelo módulo ML vira evento de pedido sem checar o app do Hub", async () => {
  const inserted = [];
  const orders = createOrdersService({
    repository: { async insertWebhook(e) { inserted.push(e); return { id: inserted.length }; } },
    stockRepository: {}, connectors, tokens: {}, onItemsChanged: async () => {}, onOrderChanged: async () => {}, webhookSecrets: async () => [],
  });
  const out = await orders.receiveRelayed({ channel: "mercadolivre", body: { topic: "orders_v2", resource: "/orders/2000001", user_id: 222, application_id: 999, sent: "s" } });
  assert.deepEqual(out, { received: 1, ids: [1] });
  assert.equal(inserted[0].externalAccountId, "222");
  assert.equal(inserted[0].resourceId, "2000001");
  const ignored = await orders.receiveRelayed({ channel: "mercadolivre", body: { topic: "shipments", resource: "/shipments/1", user_id: 222 } });
  assert.equal(ignored.received, 0);
});
