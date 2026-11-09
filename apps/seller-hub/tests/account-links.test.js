"use strict";

// Limite de contas do plano, link de autorização, apelido e registro das contas no hub de acessos.
const test = require("node:test");
const assert = require("node:assert/strict");
const { sha256 } = require("../src/platform/crypto");
const { createAccountsService } = require("../src/modules/accounts/service");
const { createAccessHub } = require("../src/platform/accessHub");
const { renderLinkPage } = require("../src/web/pages");

/** Repositório em memória com o que o serviço de contas usa. */
function fakeRepository() {
  const accounts = [], states = new Map(), links = [], audits = [];
  let nextId = 1;
  return {
    accounts, states, links, audits,
    async saveState(s) { states.set(s.stateHash, { ...s, used: false }); },
    async stateLinkId(hash, channel) { const s = states.get(hash); return s && !s.used && s.channel === channel ? s.linkId || null : null; },
    async consumeState(hash, channel) { const s = states.get(hash); if (!s || s.used || s.channel !== channel) return null; s.used = true; return { tenantId: s.tenantId, userId: s.userId, channel, linkId: s.linkId || null }; },
    async usage(tenantId) {
      const map = {};
      for (const a of accounts) if (a.tenantId === tenantId && a.status !== "disconnected") map[a.channel] = (map[a.channel] || 0) + 1;
      return Object.entries(map).map(([channel, n]) => ({ channel, accounts: n }));
    },
    async findActiveByExternal(tenantId, channel, ext) { return accounts.find((a) => a.tenantId === tenantId && a.channel === channel && a.externalAccountId === ext && a.status !== "disconnected") || null; },
    async findTenantAccount(tenantId, id) { return accounts.find((a) => a.tenantId === tenantId && a.id === id && a.status !== "disconnected") || null; },
    async upsertAccount({ tenantId, channel, externalAccountId, label }) {
      let a = accounts.find((x) => x.channel === channel && x.externalAccountId === externalAccountId);
      if (a && a.tenantId !== tenantId) return null;
      if (!a) { a = { id: nextId++, tenantId, channel, externalAccountId, label }; accounts.push(a); }
      a.status = "connected";
      return a;
    },
    async saveTokens() {}, async audit(e) { audits.push(e); }, async saveWebhookSubscription() {},
    async disconnect(tenantId, id) { const a = accounts.find((x) => x.tenantId === tenantId && x.id === id); if (!a) return null; a.status = "disconnected"; return { id }; },
    async setNickname(tenantId, id, nickname) { const a = accounts.find((x) => x.tenantId === tenantId && x.id === id); if (!a) return null; a.nickname = nickname; return { id, nickname }; },
    async createLink(l) { const row = { id: nextId++, ...l, createdBy: l.userId, expiresAt: new Date(Date.now() + l.ttlSeconds * 1000).toISOString(), openedAt: null, usedAt: null, cancelledAt: null }; links.push(row); return { id: row.id, channel: l.channel, expiresAt: row.expiresAt }; },
    async findLink(hash) { return links.find((l) => l.tokenHash === hash) || null; },
    async findLinkById(id) { return links.find((l) => l.id === id) || null; },
    async claimLink(id) { const l = links.find((x) => x.id === id); if (!l || l.openedAt || l.usedAt || l.cancelledAt) return null; l.openedAt = new Date().toISOString(); return { id }; },
    async completeLink(id, accountId) { const l = links.find((x) => x.id === id); if (!l || l.usedAt) return null; l.usedAt = new Date().toISOString(); l.accountId = accountId; return { id }; },
    async listLinks(tenantId) { return links.filter((l) => l.tenantId === tenantId); },
    async cancelLink(tenantId, id) { const l = links.find((x) => x.tenantId === tenantId && x.id === id && !x.usedAt && !x.cancelledAt); if (!l) return null; l.cancelledAt = new Date().toISOString(); return { id }; },
  };
}

/** Marketplace falso: cada código vira uma conta com o mesmo id. */
function fakeConnectors() {
  const connector = {
    configured: true,
    authorizeUrl: ({ state }) => `https://marketplace/auth?state=${state}`,
    exchangeCode: async ({ code }) => ({ tokens: { accessToken: `AT-${code}`, refreshToken: "RT" }, account: { externalAccountId: code, label: `Conta ${code}` } }),
  };
  return { has: () => true, get: () => connector, definition: () => ({ auth: "oauth", label: "Mercado Livre" }) };
}

function setup({ defaultAccountLimit = null } = {}) {
  const repository = fakeRepository();
  const reported = [];
  const resources = { sync: async (i) => { reported.push(["sync", i.channel, i.externalAccountId]); }, unlink: async (i) => { reported.push(["unlink", i.channel, i.externalAccountId]); throw new Error("hub fora do ar"); } };
  const service = createAccountsService({ repository, connectors: fakeConnectors(), cipher: { encrypt: (v) => `enc:${v}`, decrypt: (v) => v.slice(4) }, publicBaseUrl: "https://dachbyte.tech/hub", defaultAccountLimit, resources });
  return { repository, service, reported };
}

/** Conecta pelo fluxo normal (state + callback). */
async function connect(service, repository, identity, code, extra = {}) {
  const url = await service.startConnect({ identity, channel: "mercadolivre", ...extra });
  const state = new URL(url).searchParams.get("state");
  return service.finishConnect({ identity, channel: "mercadolivre", query: { state, code } });
}

test("limite do plano: conta todos os marketplaces juntos, bloqueia antes de ir ao marketplace e reconectar não gasta vaga", async () => {
  const { service, repository, reported } = setup();
  const admin = { tenantId: "t1", userId: "u1", accountLimit: 2 };
  await connect(service, repository, admin, "A");
  await connect(service, repository, admin, "B");
  assert.deepEqual(await service.usage(admin), { total: 2, limit: 2, remaining: 0, byChannel: { mercadolivre: 2 } });
  await assert.rejects(service.startConnect({ identity: admin, channel: "mercadolivre" }), { code: "account_limit_reached" });
  // "Reconectar" uma conta da empresa passa mesmo no limite, e a mesma conta voltando não ocupa vaga nova.
  const again = await connect(service, repository, admin, "A", { reconnectAccountId: 1 });
  assert.equal(again.id, 1);
  // Callback de conta nova acima do limite (ex.: duas abas ao mesmo tempo) também é barrado.
  const url = await service.startConnect({ identity: { ...admin, accountLimit: 3 }, channel: "mercadolivre" });
  const state = new URL(url).searchParams.get("state");
  await assert.rejects(service.finishConnect({ identity: admin, channel: "mercadolivre", query: { state, code: "C" } }), { code: "account_limit_reached" });
  // Desconectar libera a vaga; falha ao avisar o hub de acessos não derruba nada.
  await service.disconnect({ identity: admin, accountId: 2 });
  await connect(service, repository, admin, "C");
  assert.deepEqual(reported.map((r) => r.join(":")), ["sync:mercadolivre:A", "sync:mercadolivre:B", "sync:mercadolivre:A", "unlink:mercadolivre:B", "sync:mercadolivre:C"]);
});

test("sem limite informado: vale o padrão do ambiente; sem padrão, não limita", async () => {
  const limited = setup({ defaultAccountLimit: 1 });
  await connect(limited.service, limited.repository, { tenantId: "t1", userId: "u1" }, "A");
  await assert.rejects(limited.service.startConnect({ identity: { tenantId: "t1", userId: "u1" }, channel: "mercadolivre" }), { code: "account_limit_reached" });
  const free = setup();
  for (const code of ["A", "B", "C"]) await connect(free.service, free.repository, { tenantId: "t1", userId: "u1" }, code);
  assert.equal((await free.service.usage({ tenantId: "t1" })).limit, null);
});

test("link de autorização: uso único, sem sessão, conta entra na empresa do link com o limite guardado", async () => {
  const { service, repository } = setup();
  const admin = { tenantId: "t1", userId: "u1", accountLimit: 1 };
  const link = await service.createLink({ identity: admin, channel: "mercadolivre" });
  const token = link.url.split("/conectar/")[1];
  assert.match(link.url, /^https:\/\/dachbyte\.tech\/hub\/conectar\/[A-Za-z0-9_-]+$/);
  assert.deepEqual(await service.linkInfo(token), { status: "ready", channel: "mercadolivre" });
  const url = await service.startLink(token);
  await assert.rejects(service.startLink(token), { code: "link_in_progress" }, "o link abre uma vez só");
  const state = new URL(url).searchParams.get("state");
  assert.equal(await service.isLinkCallback("mercadolivre", state), true);
  // O state do link não serve no fluxo com login.
  const { account, identity } = await service.finishLinkConnect({ channel: "mercadolivre", query: { state, code: "SOCIO" } });
  assert.deepEqual([account.tenantId, identity.userId], ["t1", "u1"]);
  assert.equal((await service.linkInfo(token)).status, "used");
  // Plano cheio: novo link é recusado.
  await assert.rejects(service.createLink({ identity: admin, channel: "mercadolivre" }), { code: "account_limit_reached" });
  assert.equal((await service.linkInfo("nao-existe")).status, "invalid");
});

test("link cancelado não abre e state de link não passa no retorno com login", async () => {
  const { service, repository } = setup();
  const admin = { tenantId: "t1", userId: "u1" };
  const link = await service.createLink({ identity: admin, channel: "mercadolivre" });
  await service.cancelLink({ identity: admin, linkId: link.id });
  await assert.rejects(service.startLink(link.url.split("/conectar/")[1]), { code: "link_cancelled" });
  const other = await service.createLink({ identity: admin, channel: "mercadolivre" });
  const state = new URL(await service.startLink(other.url.split("/conectar/")[1])).searchParams.get("state");
  await assert.rejects(service.finishConnect({ identity: admin, channel: "mercadolivre", query: { state, code: "X" } }), { code: "invalid_state" });
  assert.ok(repository.links.every((l) => l.tokenHash !== other.url.split("/conectar/")[1]), "só o hash do token fica guardado");
  assert.ok(repository.links.some((l) => l.tokenHash === sha256(other.url.split("/conectar/")[1])));
});

test("apelido: limpa espaços, limita a 60 caracteres e vazio volta ao nome do marketplace", async () => {
  const { service, repository } = setup();
  const admin = { tenantId: "t1", userId: "u1" };
  await connect(service, repository, admin, "A");
  assert.deepEqual(await service.setNickname({ identity: admin, accountId: 1, nickname: "  Loja   Matriz " }), { id: 1, nickname: "Loja Matriz" });
  assert.equal((await service.setNickname({ identity: admin, accountId: 1, nickname: "" })).nickname, null);
  await assert.rejects(service.setNickname({ identity: { tenantId: "t2", userId: "x" }, accountId: 1, nickname: "x" }), { code: "account_not_found" });
});

test("hub de acessos: lê o limite do plano e registra/remove a conta como recurso do dach_hub", async () => {
  const calls = [];
  let body = { allow: true, reason: "ok", limits: { channel_accounts: 10 } };
  const fetchImpl = async (url, init) => { calls.push({ path: new URL(url).pathname, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => body }; };
  const hub = createAccessHub({ baseUrl: "https://acessos", token: "tok", module: "dach_hub", fetchImpl });
  assert.equal((await hub.checkAccess({ tenantId: "t1", userId: "u1" })).accountLimit, 10);
  body = { allow: true, reason: "ok" };
  assert.equal((await hub.checkAccess({ tenantId: "t2", userId: "u1" })).accountLimit, null);
  await hub.syncResource({ tenantId: "t1", channel: "shopee", externalAccountId: "77", label: "Loja" });
  await hub.unlinkResource({ tenantId: "t1", channel: "shopee", externalAccountId: "77" });
  assert.deepEqual(calls.slice(2).map((c) => [c.path, c.body.module_slug, c.body.account_id]), [
    ["/v1/internal/resources/sync", "dach_hub", "shopee:77"], ["/v1/internal/resources/unlink", "dach_hub", "shopee:77"]]);
});

test("página pública do link: pronto mostra o botão; usado/expirado só explicam", () => {
  const ready = renderLinkPage({ status: "ready", channelLabel: "Shopee", token: "abc" });
  assert.match(ready, /href="\/hub\/conectar\/abc\/iniciar"/);
  assert.match(ready, /janela anônima/);
  assert.doesNotMatch(renderLinkPage({ status: "expired", channelLabel: "Shopee", token: "abc" }), /iniciar/);
  assert.match(renderLinkPage({ status: "failed", channelLabel: "Shopee", token: "", message: "<b>x</b>" }), /&lt;b&gt;x&lt;\/b&gt;/);
});
