"use strict";

// Avisos do Magalu com segredo por conta, contra Postgres de verdade (HUB_TEST_DATABASE_URL), sem rede.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("../src/platform/db");
const { createCipher, hmacSha256Hex } = require("../src/platform/crypto");
const { createAccountsRepository } = require("../src/modules/accounts/repository");
const { createAccountsService } = require("../src/modules/accounts/service");
const { createOrdersRepository } = require("../src/modules/orders/repository");
const { createOrdersService } = require("../src/modules/orders/service");
const { createStockRepository } = require("../src/modules/stock/repository");
const { MagaluConnector } = require("../src/connectors/magalu/MagaluConnector");

const url = process.env.HUB_TEST_DATABASE_URL || "";
const opts = { skip: url ? false : "defina HUB_TEST_DATABASE_URL para rodar" };
const db = url ? createDb({ databaseUrl: url, schema: "hub" }) : null;
const T = "tenant-webhooks";

test.after(async () => { if (db) await db.close(); });

test("Magalu: segredo guardado por conta confere o aviso; conta desconectada para de valer", opts, async () => {
  await db.query("truncate hub.channel_accounts, hub.webhook_events, hub.audit_events restart identity cascade");
  const cipher = createCipher("chave-teste");
  const magalu = new MagaluConnector({ clientId: "c", clientSecret: "s" });
  magalu.subscribeWebhooks = async () => ({ secrets: ["whsec_conta"], topics: ["orders_order"] });
  const connectors = { get: () => magalu, has: () => true, definition: () => ({ auth: "oauth" }) };
  const repository = createAccountsRepository(db);
  const accounts = createAccountsService({ repository, connectors, cipher, publicBaseUrl: "https://dachbyte.tech/hub" });
  const stored = await repository.upsertAccount({ tenantId: T, channel: "magalu", externalAccountId: "ten-1", label: "Loja", userId: "u" });
  await repository.saveWebhookSubscription(Number(stored.id), { secretsEnc: cipher.encrypt(JSON.stringify(["whsec_conta"])), error: null });
  await repository.saveWebhookSubscription(Number(stored.id), { secretsEnc: null, error: "Forbidden" });
  const row = await db.queryOne("select webhook_secrets_enc, webhooks_subscribed_at, webhooks_error from hub.channel_accounts where id = $1", [stored.id]);
  assert.ok(row.webhook_secrets_enc && !row.webhook_secrets_enc.includes("whsec"), "segredo cifrado e mantido após falha");
  assert.equal(row.webhooks_error, "Forbidden");
  assert.ok(row.webhooks_subscribed_at);
  const listed = await accounts.listAccounts(T);
  assert.deepEqual([Boolean(listed[0].webhooks.subscribedAt), listed[0].webhooks.error], [true, "Forbidden"]);

  const orders = createOrdersService({
    repository: createOrdersRepository(db), stockRepository: createStockRepository(db), connectors, tokens: { getAccessToken: async () => ({ accessToken: "T", externalAccountId: "ten-1" }) },
    webhookSecrets: (channel, ext) => accounts.webhookSecrets(channel, ext),
  });
  const body = Buffer.from(JSON.stringify({ tenant_id: "ten-1", topic: "orders_order", data: { params: { id: "LU-9" } } }));
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = (secret) => ({ "x-timestamp": ts, "x-signature-256": `sha256=${hmacSha256Hex(secret, `${ts}.${body.toString("utf8")}`)}` });
  const ok = await orders.receiveWebhook({ channel: "magalu", headers: headers("whsec_conta"), rawBody: body, url: "" });
  assert.equal(ok.ids.length, 1, "aviso aceito com o segredo da conta");
  await assert.rejects(() => orders.receiveWebhook({ channel: "magalu", headers: headers("whsec_outro"), rawBody: body, url: "" }), (e) => e.status === 401);

  await repository.disconnect(T, Number(stored.id));
  assert.deepEqual(await accounts.webhookSecrets("magalu", "ten-1"), [], "desconectar apaga o segredo");
  assert.equal((await orders.receiveWebhook({ channel: "magalu", headers: headers("whsec_conta"), rawBody: body, url: "" })).received, 0, "aviso de conta desconectada é ignorado");
});
