"use strict";

// Limite, links de autorização e apelido contra Postgres de verdade (HUB_TEST_DATABASE_URL).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("../src/platform/db");
const { createAccountsRepository } = require("../src/modules/accounts/repository");
const { createAccountsService } = require("../src/modules/accounts/service");
const { createAnalyticsRepository } = require("../src/modules/analytics/repository");

const url = process.env.HUB_TEST_DATABASE_URL || "";
const opts = { skip: url ? false : "defina HUB_TEST_DATABASE_URL para rodar" };
const db = url ? createDb({ databaseUrl: url, schema: "hub" }) : null;
const T = "tenant-links";

const connectors = {
  has: () => true, definition: () => ({ auth: "oauth", label: "Shopee" }),
  get: () => ({ configured: true, authorizeUrl: ({ state }) => `https://mk/auth?state=${state}`,
    exchangeCode: async ({ code }) => ({ tokens: { accessToken: "AT", refreshToken: "RT" }, account: { externalAccountId: code, label: `Loja ${code}` } }) }),
};

test.after(async () => { if (db) await db.close(); });

test("link, limite e apelido no banco: link de uso único, contas por canal e apelido nas telas", opts, async () => {
  await db.query("truncate hub.items, hub.channel_accounts, hub.oauth_states, hub.authorization_links, hub.audit_events restart identity cascade");
  const repository = createAccountsRepository(db);
  const service = createAccountsService({ repository, connectors, cipher: { encrypt: (v) => v, decrypt: (v) => v }, publicBaseUrl: "https://x/hub" });
  const admin = { tenantId: T, userId: "u1", accountLimit: 2 };

  const link = await service.createLink({ identity: admin, channel: "shopee" });
  const token = link.url.split("/conectar/")[1];
  const state = new URL(await service.startLink(token)).searchParams.get("state");
  await assert.rejects(service.startLink(token), { code: "link_in_progress" });
  assert.equal(await service.isLinkCallback("shopee", state), true);
  const { account } = await service.finishLinkConnect({ channel: "shopee", query: { state, code: "S1" } });
  assert.equal(await service.isLinkCallback("shopee", state), false, "state consumido");
  const [row] = await service.listLinks(T);
  assert.deepEqual([row.status, row.account], ["used", "Loja S1"]);

  await service.setNickname({ identity: admin, accountId: Number(account.id), nickname: "Outlet" });
  assert.equal((await service.listAccounts(T))[0].nickname, "Outlet");
  await db.query("insert into hub.channel_orders (channel_account_id, external_order_id, status, total, ordered_at) values ($1, 'O1', 'open', 50, now())", [account.id]);
  const sales = await createAnalyticsRepository(db).salesByAccount(T, { from: "2000-01-01", to: "2100-01-01", channel: null, accountId: null });
  assert.equal(sales[0].account, "Outlet", "apelido aparece na Análise");

  assert.deepEqual(await service.usage(admin), { total: 1, limit: 2, remaining: 1, byChannel: { shopee: 1 } });
  const second = await service.createLink({ identity: admin, channel: "shopee" });
  await service.cancelLink({ identity: admin, linkId: second.id });
  assert.equal((await service.linkInfo(second.url.split("/conectar/")[1])).status, "cancelled");
});
