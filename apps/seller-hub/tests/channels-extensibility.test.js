"use strict";

// Preparação para novos marketplaces e lojas virtuais: tudo sai do catálogo de canais.
const test = require("node:test");
const assert = require("node:assert/strict");
const { CHANNEL_DEFINITIONS, validateDefinition, channelSettingsFromEnv } = require("../src/connectors/channels");
const { ChannelConnector } = require("../src/connectors/contract");
const { createConnectors } = require("../src/connectors/registry");
const { createAccountsService } = require("../src/modules/accounts/service");
const { createCipher } = require("../src/platform/crypto");
const { loadConfig } = require("../src/platform/config");

/** Loja virtual de exemplo que conecta por chave de API (como Nuvemshop/WooCommerce fariam). */
class FakeStoreConnector extends ChannelConnector {
  constructor(settings) { super(); this.settings = settings; this.received = null; }
  get channel() { return "lojateste"; }
  get configured() { return true; }
  async connectWithCredentials(fields) {
    this.received = fields;
    if (fields.apiKey !== "chave-boa") throw Object.assign(new Error("Chave recusada pela loja."), { status: 400 });
    return { tokens: { accessToken: fields.apiKey, refreshToken: null, expiresAt: null, scopes: [] }, account: { externalAccountId: fields.storeUrl, label: "Loja Teste" } };
  }
}

const STORE = {
  id: "lojateste", label: "Loja Teste", kind: "store", auth: "credentials",
  capabilities: { listings: true, stockWrite: true, priceWrite: false, orders: true, fulfillment: false },
  credentialFields: [{ name: "storeUrl", label: "Endereço da loja", type: "url" }, { name: "apiKey", label: "Chave de API", type: "password" }],
  settingsFromEnv: (env) => ({ secret: env.HUB_LOJATESTE_SECRET || "" }),
  create: (settings) => new FakeStoreConnector(settings),
};

test("canais atuais são válidos, únicos e marcados como marketplace", () => {
  for (const def of CHANNEL_DEFINITIONS) assert.deepEqual(validateDefinition(def), [], def.id);
  const ids = CHANNEL_DEFINITIONS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(CHANNEL_DEFINITIONS.every((d) => d.kind === "marketplace" && d.auth === "oauth"));
});

test("configuração de cada canal vem da própria definição", () => {
  const config = loadConfig({ HUB_ML_APP_ID: "1", HUB_SHOPEE_PARTNER_ID: "9" });
  assert.equal(config.channels.mercadolivre.clientId, "1");
  assert.equal(config.channels.shopee.partnerId, "9");
  assert.equal(config.channels.shopee.apiBase, "https://partner.shopeemobile.com");
  assert.deepEqual(channelSettingsFromEnv({ HUB_LOJATESTE_SECRET: "x" }, [STORE]), { lojateste: { secret: "x" } });
});

test("loja virtual entra só com uma definição nova, sem expor segredos na lista", () => {
  const registry = createConnectors({ lojateste: { secret: "s" } }, fetch, [...CHANNEL_DEFINITIONS, STORE]);
  const store = registry.list().find((c) => c.id === "lojateste");
  assert.equal(store.kind, "store");
  assert.equal(store.auth, "credentials");
  assert.equal(store.capabilities.priceWrite, false);
  assert.deepEqual(store.credentialFields.map((f) => f.name), ["storeUrl", "apiKey"]);
  assert.ok(!JSON.stringify(registry.list()).includes("\"s\""), "settings não vão para a tela");
  assert.equal(registry.get("lojateste").settings.secret, "s");
});

test("definição inválida ou repetida é recusada na subida", () => {
  assert.throws(() => createConnectors({}, fetch, [{ ...STORE, kind: "erp" }]), /kind/);
  assert.throws(() => createConnectors({}, fetch, [{ ...STORE, credentialFields: [] }]), /credentialFields/);
  assert.throws(() => createConnectors({}, fetch, [{ ...STORE, id: "Loja Teste" }]), /id/);
  assert.throws(() => createConnectors({}, fetch, [STORE, STORE]), /duplicado/);
});

test("conexão por formulário: só campos declarados, campo vazio barrado, OAuth recusado", async () => {
  const registry = createConnectors({}, fetch, [STORE]);
  const saved = { tokens: null, audits: [] };
  const repository = {
    async upsertAccount(input) { return { id: 7, ...input }; },
    async saveTokens(_id, tokens) { saved.tokens = tokens; },
    async audit(event) { saved.audits.push(event); },
  };
  const cipher = createCipher("k");
  const service = createAccountsService({ repository, connectors: registry, cipher, publicBaseUrl: "https://x/hub" });
  const identity = { tenantId: "t1", userId: "u1" };

  await assert.rejects(() => service.connectWithCredentials({ identity, channel: "lojateste", fields: { storeUrl: "https://loja.com" } }), (e) => e.code === "missing_field");
  const account = await service.connectWithCredentials({ identity, channel: "lojateste", fields: { storeUrl: " https://loja.com ", apiKey: "chave-boa", extra: "ignorar" } });
  assert.equal(account.externalAccountId, "https://loja.com");
  assert.deepEqual(registry.get("lojateste").received, { storeUrl: "https://loja.com", apiKey: "chave-boa" });
  assert.equal(cipher.decrypt(saved.tokens.accessTokenEnc), "chave-boa");
  assert.equal(saved.audits[0].details.channel, "lojateste");
  await assert.rejects(() => service.connectWithCredentials({ identity, channel: "lojateste", fields: { storeUrl: "u", apiKey: "ruim" } }), /recusada/);
  await assert.rejects(() => service.startConnect({ identity, channel: "lojateste" }), (e) => e.code === "wrong_connect_method");
});
