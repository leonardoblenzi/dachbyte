"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCipher, sha256, hmacSha256Hex } = require("../src/platform/crypto");
const { MercadoLivreConnector } = require("../src/connectors/mercadolivre/MercadoLivreConnector");
const { MagaluConnector } = require("../src/connectors/magalu/MagaluConnector");
const { ShopeeConnector } = require("../src/connectors/shopee/ShopeeConnector");
const { createConnectors } = require("../src/connectors/registry");
const { createAccountsService, TokenManager } = require("../src/modules/accounts/service");

/** fetch falso: devolve respostas por trecho de URL e guarda as chamadas. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    const { status = 200, body = {} } = key ? routes[key] : { status: 404, body: { error: "not_found" } };
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  return { impl, calls };
}

const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;

test("cifra AES-GCM: ida e volta, e dado adulterado é rejeitado", () => {
  const cipher = createCipher("chave-de-teste");
  const sealed = cipher.encrypt("APP_USR-123");
  assert.match(sealed, /^enc::v1::/);
  assert.notEqual(sealed, cipher.encrypt("APP_USR-123"), "IV aleatório");
  assert.equal(cipher.decrypt(sealed), "APP_USR-123");
  assert.throws(() => cipher.decrypt(sealed.slice(0, -2) + "AA"));
  assert.throws(() => createCipher(""), /HUB_TOKEN_ENCRYPTION_KEY/);
});

test("Mercado Livre: URL de autorização, troca do código e identificação da conta", async () => {
  const { impl, calls } = fakeFetch({
    "/oauth/token": { body: { access_token: "AT", refresh_token: "RT", expires_in: 21600, scope: "offline_access read write" } },
    "/users/me": { body: { id: 123456, nickname: "LOJA_DEMO" } },
  });
  const ml = new MercadoLivreConnector({ clientId: "app1", clientSecret: "s", fetchImpl: impl });
  const url = new URL(ml.authorizeUrl({ state: "abc", redirectUri: "https://x/hub/auth/mercadolivre/callback" }));
  assert.equal(url.origin + url.pathname, "https://auth.mercadolivre.com.br/authorization");
  assert.equal(url.searchParams.get("client_id"), "app1");
  assert.equal(url.searchParams.get("state"), "abc");
  const { tokens, account } = await ml.exchangeCode({ code: "TG-1", redirectUri: "https://x/cb" });
  assert.equal(tokens.refreshToken, "RT");
  assert.ok(tokens.expiresAt > new Date());
  assert.deepEqual(account, { externalAccountId: "123456", label: "LOJA_DEMO" });
  assert.match(calls[0].init.body, /grant_type=authorization_code/);
  assert.equal(calls[1].init.headers.authorization, "Bearer AT");
});

test("Magalu: escopos na autorização e conta pelo claim sub do token", async () => {
  const access = jwt({ sub: "tenant-uuid-1", exp: Math.floor(Date.now() / 1000) + 3600 });
  const { impl } = fakeFetch({ "id.magalu.com/oauth/token": { body: { access_token: access, refresh_token: "R1" } } });
  const magalu = new MagaluConnector({ clientId: "c", clientSecret: "s", fetchImpl: impl });
  const url = new URL(magalu.authorizeUrl({ state: "st", redirectUri: "https://x/cb" }));
  assert.match(url.searchParams.get("scope"), /open:portfolio-stocks-seller:write/);
  assert.equal(url.searchParams.get("choose_tenants"), "true");
  const { tokens, account } = await magalu.exchangeCode({ code: "c1", redirectUri: "https://x/cb" });
  assert.equal(account.externalAccountId, "tenant-uuid-1");
  assert.ok(tokens.expiresAt instanceof Date);
  assert.throws(() => MagaluConnector.identity(jwt({})), /organização/);
});

test("Shopee: assinatura HMAC, state dentro do redirect e shop_id obrigatório", async () => {
  const { impl, calls } = fakeFetch({ "/api/v2/auth/token/get": { body: { access_token: "A", refresh_token: "R", expire_in: 14400 } } });
  const shopee = new ShopeeConnector({ partnerId: "999", partnerKey: "key", fetchImpl: impl, now: () => 1700000000 });
  const url = new URL(shopee.authorizeUrl({ state: "st-1", redirectUri: "https://x/hub/auth/shopee/callback" }));
  assert.equal(url.searchParams.get("sign"), hmacSha256Hex("key", "999/api/v2/shop/auth_partner1700000000"));
  assert.equal(new URL(url.searchParams.get("redirect")).searchParams.get("state"), "st-1");
  await assert.rejects(() => shopee.exchangeCode({ code: "c" }), /shop_id/);
  const { account } = await shopee.exchangeCode({ code: "c", shopId: "348584331" });
  assert.equal(account.externalAccountId, "348584331");
  assert.match(calls[0].url, /sign=[0-9a-f]{64}/);
  assert.equal(JSON.parse(calls[0].init.body).partner_id, 999);
});

test("registro de canais: disponível só com o app configurado", () => {
  const registry = createConnectors({
    mercadolivre: { clientId: "a", clientSecret: "b" },
    magalu: { clientId: "", clientSecret: "", scopes: [] },
    shopee: { partnerId: "", partnerKey: "", apiBase: "" },
  });
  assert.deepEqual(registry.list().map((c) => [c.id, c.available]), [["mercadolivre", true], ["magalu", false], ["shopee", false]]);
  assert.throws(() => registry.get("amazon"), /desconhecido/);
});

function fakeAccountsRepo({ owner = "t1" } = {}) {
  const state = { states: new Map(), tokens: new Map(), audits: [], reconnect: [] };
  return {
    state,
    async saveState({ stateHash, tenantId, userId, channel }) { state.states.set(stateHash, { tenantId, userId, channel, used: false }); },
    async consumeState(hash, channel) {
      const s = state.states.get(hash);
      if (!s || s.used || s.channel !== channel) return null;
      s.used = true;
      return s;
    },
    async upsertAccount(input) { return input.tenantId === owner ? { id: 42, ...input } : null; },
    async saveTokens(id, tokens) { state.tokens.set(id, tokens); },
    async audit(event) { state.audits.push(event); },
    webhooks: new Map(),
    async saveWebhookSubscription(id, { secretsEnc, error }) {
      const prev = this.webhooks.get(id) || {};
      this.webhooks.set(id, { secretsEnc: secretsEnc ?? prev.secretsEnc ?? null, error });
    },
    async webhookSecrets(_channel, externalAccountId) { return externalAccountId === "S1" ? this.webhooks.get(42)?.secretsEnc || null : null; },
    async findTenantAccount(tenantId, id) { return tenantId === owner && id === 42 ? { id: 42, channel: "magalu", externalAccountId: "S1", tenantId } : null; },
  };
}

test("conectar conta: state de uso único, posse protegida e tokens cifrados", async () => {
  const cipher = createCipher("k");
  const connector = { configured: true, authorizeUrl: ({ state }) => `https://mk/auth?state=${state}`, exchangeCode: async () => ({ tokens: { accessToken: "AT", refreshToken: "RT", expiresAt: null, scopes: [] }, account: { externalAccountId: "S1", label: "Loja" } }) };
  const connectors = { get: () => connector, definition: () => ({ auth: "oauth" }) };
  const identity = { tenantId: "t1", userId: "u1" };
  const repo = fakeAccountsRepo();
  const service = createAccountsService({ repository: repo, connectors, cipher, publicBaseUrl: "https://dachbyte.tech/hub" });
  assert.equal(service.redirectUri("magalu"), "https://dachbyte.tech/hub/auth/magalu/callback");

  const url = await service.startConnect({ identity, channel: "magalu" });
  const state = new URL(url).searchParams.get("state");
  assert.ok(repo.state.states.has(sha256(state)), "só o hash do state é guardado");

  const account = await service.finishConnect({ identity, channel: "magalu", query: { state, code: "c" } });
  assert.equal(account.id, 42);
  const saved = repo.state.tokens.get(42);
  assert.notEqual(saved.accessTokenEnc, "AT");
  assert.equal(cipher.decrypt(saved.accessTokenEnc), "AT");
  assert.equal(repo.state.audits[0].action, "account_connected");

  await assert.rejects(() => service.finishConnect({ identity, channel: "magalu", query: { state, code: "c" } }), (e) => e.code === "invalid_state", "state não pode ser reusado");
  const other = await service.startConnect({ identity: { tenantId: "t1", userId: "u2" }, channel: "magalu" });
  await assert.rejects(() => service.finishConnect({ identity, channel: "magalu", query: { state: new URL(other).searchParams.get("state"), code: "c" } }), (e) => e.code === "invalid_state", "state de outro usuário");
  await assert.rejects(() => service.finishConnect({ identity, channel: "magalu", query: { error: "access_denied" } }), (e) => e.code === "authorization_denied");
});

test("Magalu: ao conectar, assina os avisos e guarda o segredo cifrado; falha não desfaz a conexão", async () => {
  const cipher = createCipher("k");
  let mode = "ok";
  const subscribed = [];
  const connector = {
    configured: true, authorizeUrl: ({ state }) => `https://mk/auth?state=${state}`,
    exchangeCode: async () => ({ tokens: { accessToken: "AT", refreshToken: "RT", expiresAt: null, scopes: [] }, account: { externalAccountId: "S1", label: "Loja" } }),
    async subscribeWebhooks(account, { url }) {
      subscribed.push([account.accessToken, url]);
      if (mode === "fail") throw new Error("Forbidden");
      return { secrets: [mode === "ok" ? "whsec_1" : "whsec_2"], topics: ["orders_order"] };
    },
  };
  const connectors = { get: () => connector, has: () => true, definition: () => ({ auth: "oauth" }) };
  const identity = { tenantId: "t1", userId: "u1" };
  const repo = fakeAccountsRepo();
  repo.listAccounts = async () => [{ id: 42, channel: "magalu", webhooksAt: new Date(), webhooksError: null }];
  const tokens = { getAccessToken: async () => ({ accessToken: "AT2", externalAccountId: "S1" }) };
  const service = createAccountsService({ repository: repo, connectors, cipher, publicBaseUrl: "https://dachbyte.tech/hub", tokens });
  const connect = async () => {
    const state = new URL(await service.startConnect({ identity, channel: "magalu" })).searchParams.get("state");
    return service.finishConnect({ identity, channel: "magalu", query: { state, code: "c" } });
  };
  await connect();
  assert.deepEqual(subscribed[0], ["AT", "https://dachbyte.tech/hub/webhooks/magalu"]);
  assert.notEqual(repo.webhooks.get(42).secretsEnc, "whsec_1", "segredo guardado cifrado");
  assert.deepEqual(await service.webhookSecrets("magalu", "S1"), ["whsec_1"]);
  assert.deepEqual(await service.webhookSecrets("magalu", "outra"), []);
  assert.ok((await service.listAccounts("t1"))[0].webhooks.subscribedAt, "situação dos avisos na lista de contas");

  mode = "fail";
  const account = await connect();
  assert.equal(account.id, 42, "falha na assinatura não desfaz a conexão");
  assert.equal(repo.webhooks.get(42).error, "Forbidden");
  assert.deepEqual(await service.webhookSecrets("magalu", "S1"), ["whsec_1"], "mantém o segredo anterior");
  await assert.rejects(() => service.resubscribeWebhooks({ identity, accountId: 42 }), (e) => e.code === "webhooks_subscribe_failed");

  mode = "rotate";
  assert.deepEqual(await service.resubscribeWebhooks({ identity, accountId: 42 }), { ok: true });
  assert.equal(subscribed.at(-1)[0], "AT2", "assinar de novo usa o token atual da conta");
  assert.deepEqual(await service.webhookSecrets("magalu", "S1"), ["whsec_2"]);
  assert.equal(repo.webhooks.get(42).error, null);
  await assert.rejects(() => service.resubscribeWebhooks({ identity: { tenantId: "outra", userId: "u" }, accountId: 42 }), (e) => e.status === 404);
});

test("conta já ligada a outra empresa é bloqueada", async () => {
  const repo = fakeAccountsRepo({ owner: "outra" });
  const connector = { configured: true, authorizeUrl: ({ state }) => `https://mk/?state=${state}`, exchangeCode: async () => ({ tokens: { accessToken: "A", refreshToken: null, expiresAt: null, scopes: [] }, account: { externalAccountId: "S1", label: null } }) };
  const service = createAccountsService({ repository: repo, connectors: { get: () => connector, definition: () => ({ auth: "oauth" }) }, cipher: createCipher("k"), publicBaseUrl: "https://x/hub" });
  const identity = { tenantId: "t1", userId: "u1" };
  const state = new URL(await service.startConnect({ identity, channel: "shopee" })).searchParams.get("state");
  await assert.rejects(() => service.finishConnect({ identity, channel: "shopee", query: { state, code: "c", shop_id: "1" } }), (e) => e.status === 409);
  assert.equal(repo.state.tokens.size, 0);
});

test("app sem configuração não deixa iniciar conexão", async () => {
  const service = createAccountsService({ repository: fakeAccountsRepo(), connectors: { get: () => ({ configured: false }), definition: () => ({ auth: "oauth" }) }, cipher: createCipher("k"), publicBaseUrl: "https://x" });
  await assert.rejects(() => service.startConnect({ identity: { tenantId: "t", userId: "u" }, channel: "magalu" }), (e) => e.code === "channel_not_configured");
});

function tokenRepo(row) {
  const calls = { saved: [], reconnect: 0, locks: 0 };
  return {
    calls,
    async withTokenLock(_id, work) { calls.locks += 1; return work({ client: {}, row }); },
    async saveTokens(_id, tokens) { calls.saved.push(tokens); },
    async markReconnectRequired() { calls.reconnect += 1; },
  };
}

test("token válido é entregue sem renovar", async () => {
  const cipher = createCipher("k");
  const repo = tokenRepo({ channel: "mercadolivre", externalAccountId: "1", status: "connected", accessTokenEnc: cipher.encrypt("AT"), refreshTokenEnc: cipher.encrypt("RT"), expiresAt: new Date(Date.now() + 3600e3) });
  const manager = new TokenManager({ repository: repo, connectors: { get: () => { throw new Error("não deveria renovar"); } }, cipher });
  assert.equal((await manager.getAccessToken(1)).accessToken, "AT");
  assert.equal(repo.calls.locks, 1);
});

test("token perto de expirar é renovado sob a trava e o novo refresh é salvo", async () => {
  const cipher = createCipher("k");
  const repo = tokenRepo({ channel: "mercadolivre", externalAccountId: "1", status: "connected", accessTokenEnc: cipher.encrypt("OLD"), refreshTokenEnc: cipher.encrypt("RT1"), expiresAt: new Date(Date.now() + 60e3) });
  let usedRefresh = null;
  const connectors = { get: () => ({ refresh: async ({ refreshToken }) => { usedRefresh = refreshToken; return { accessToken: "NEW", refreshToken: "RT2", expiresAt: new Date(Date.now() + 6 * 3600e3), scopes: [] }; } }) };
  const manager = new TokenManager({ repository: repo, connectors, cipher });
  assert.equal((await manager.getAccessToken(1)).accessToken, "NEW");
  assert.equal(usedRefresh, "RT1");
  assert.equal(cipher.decrypt(repo.calls.saved[0].refreshTokenEnc), "RT2");
});

test("refresh recusado marca a conta para reconectar (sem rollback) e responde 409", async () => {
  const cipher = createCipher("k");
  const repo = tokenRepo({ channel: "mercadolivre", externalAccountId: "1", status: "connected", accessTokenEnc: cipher.encrypt("OLD"), refreshTokenEnc: cipher.encrypt("RT"), expiresAt: new Date(Date.now() - 1000) });
  const connectors = { get: () => ({ refresh: async () => { throw Object.assign(new Error("invalid_grant"), { status: 400, code: "invalid_grant" }); } }) };
  const manager = new TokenManager({ repository: repo, connectors, cipher });
  await assert.rejects(() => manager.getAccessToken(1), (e) => e.status === 409 && e.code === "reconnect_required");
  assert.equal(repo.calls.reconnect, 1);
});
