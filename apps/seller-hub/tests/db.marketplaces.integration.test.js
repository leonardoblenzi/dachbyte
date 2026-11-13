"use strict";

// Marketplaces (fase 1) com Postgres de verdade. Roda só com HUB_TEST_DATABASE_URL (banco descartável, migrations aplicadas).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("../src/platform/db");
const { createAccountsRepository } = require("../src/modules/accounts/repository");
const { createCatalogRepository } = require("../src/modules/catalog/repository");
const { createCatalogService } = require("../src/modules/catalog/service");
const { createStockRepository } = require("../src/modules/stock/repository");
const { createStockService } = require("../src/modules/stock/service");
const { createMarketplacesRepository } = require("../src/modules/marketplaces/repository");
const { createMarketplacesService } = require("../src/modules/marketplaces/service");

const url = process.env.HUB_TEST_DATABASE_URL || "";
const opts = { skip: url ? false : "defina HUB_TEST_DATABASE_URL para rodar" };
const db = url ? createDb({ databaseUrl: url, schema: "hub" }) : null;
const T = "tenant-a", OTHER = "tenant-b";
const CHANNELS = [{ id: "mercadolivre", label: "Mercado Livre", kind: "marketplace", available: true }, { id: "magalu", label: "Magalu", kind: "marketplace", available: true }];

/** Duas contas ML (uma com anúncio Full e um sem vínculo), uma Magalu e uma conta ML de outra empresa. */
async function seed() {
  await db.query("truncate hub.items, hub.channel_accounts, hub.locations, hub.audit_events, hub.oauth_states restart identity cascade");
  const accounts = createAccountsRepository(db);
  const a1 = await accounts.upsertAccount({ tenantId: T, channel: "mercadolivre", externalAccountId: "111", label: "LOJA A", userId: "u1" });
  const a2 = await accounts.upsertAccount({ tenantId: T, channel: "mercadolivre", externalAccountId: "222", label: "LOJA B", userId: "u1" });
  const mg = await accounts.upsertAccount({ tenantId: T, channel: "magalu", externalAccountId: "mg-1", label: "Magalu A", userId: "u1" });
  const other = await accounts.upsertAccount({ tenantId: OTHER, channel: "mercadolivre", externalAccountId: "999", label: "OUTRA", userId: "u9" });
  const catalog = createCatalogService({ repository: createCatalogRepository(db) });
  await catalog.applyListings({ tenantId: T, accountId: a1.id, listings: [
    { listingId: "MLB1", channelSku: "SOFA-1", title: "Sofá Retrô", stock: 4, price: 1190.9, status: "active" },
    { listingId: "MLB2", variationId: "77", channelSku: "MESA", title: "Mesa Oval", stock: 0, price: 399, status: "paused" },
    { listingId: "MLB3", channelSku: "SOFA-1", title: "Sofá Full", stock: 50, price: 1190.9, status: "active", fulfillment: true },
    { listingId: "MLB4", channelSku: null, title: "Banqueta sem SKU", stock: 2, price: 150, status: "under_review" },
  ] });
  await catalog.applyListings({ tenantId: T, accountId: a2.id, listings: [{ listingId: "MLB9", channelSku: "MESA", title: "Mesa Oval", stock: 1, price: 410, status: "active" }] });
  await catalog.applyListings({ tenantId: T, accountId: mg.id, listings: [{ listingId: "SOFA-1", channelSku: "SOFA-1", title: "Sofá Retrô", stock: 3 }] });
  await catalog.applyListings({ tenantId: OTHER, accountId: other.id, listings: [{ listingId: "MLB777", channelSku: "X", title: "De outra empresa", stock: 1 }] });
  const stock = createStockService({ repository: createStockRepository(db) });
  await stock.initialFromChannels({ identity: { tenantId: T, userId: "u1" }, source: "lowest", apply: true });
  const listing = async (code) => Number((await db.queryOne("select id from hub.listings where listing_id = $1", [code])).id);
  return { a1: Number(a1.id), a2: Number(a2.id), mg: Number(mg.id), other: Number(other.id), listing };
}

const repo = () => createMarketplacesRepository(db);
const service = () => createMarketplacesService({ repository: repo(), stockRepository: createStockRepository(db), channels: () => CHANNELS });
const identity = { tenantId: T, userId: "u1" };

test.after(async () => { if (db) await db.close(); });

test("regra de preço: grava, atualiza no mesmo lugar, remove e não alcança outra empresa", opts, async () => {
  const { a1, other, listing } = await seed();
  const mp = service();
  await mp.savePriceRule({ identity, scope: "account", targetId: a1, rule: { base: "promo_or_sale", adjust: "pct", value: "12", rounding: "90", minPrice: "99,90" } });
  const again = await mp.savePriceRule({ identity, scope: "account", targetId: a1, rule: { adjust: "amount", value: "-5" } });
  assert.equal(again.ruleText, "Preço de venda − R$ 5,00");
  const rows = (await db.query("select scope, adjust, value::float as value, min_price from hub.price_rules where channel_account_id = $1", [a1])).rows;
  assert.deepEqual(rows, [{ scope: "account", adjust: "amount", value: -5, min_price: null }], "uma linha por conta");
  const mlb2 = await listing("MLB2");
  await mp.savePriceRule({ identity, scope: "listing", targetId: mlb2, rule: { adjust: "fixed", value: "389,90" } });
  assert.equal((await db.queryOne("select count(*)::int as n from hub.price_rules where listing_id = $1", [mlb2])).n, 1);
  await assert.rejects(mp.savePriceRule({ identity, scope: "account", targetId: other, rule: { value: "1" } }), (e) => e.status === 404, "conta de outra empresa");
  await mp.savePriceRule({ identity, scope: "listing", targetId: mlb2, rule: null });
  assert.equal((await db.queryOne("select count(*)::int as n from hub.price_rules where listing_id = $1", [mlb2])).n, 0);
  const audit = (await db.query("select action from hub.audit_events where tenant_id = $1 and action = 'price_rule_saved'", [T])).rows;
  assert.equal(audit.length, 4);
  await assert.rejects(db.query("insert into hub.price_rules (tenant_id, scope, channel_account_id, adjust, value) values ($1, 'account', $2, 'fixed', 0)", [T, a1]),
    /ck_hub_price_rules_value|duplicate key/, "banco recusa regra inválida");
});

test("anúncios do canal: filtros, abas e estoque/preço calculados", opts, async () => {
  const { a1, a2, listing } = await seed();
  const mp = service();
  await mp.savePriceRule({ identity, scope: "account", targetId: a1, rule: { adjust: "pct", value: "10" } });
  await mp.savePriceRule({ identity, scope: "listing", targetId: await listing("MLB2"), rule: { adjust: "fixed", value: "389,90" } });
  await createStockService({ repository: createStockRepository(db) }).saveRule({ identity, scope: "account", targetId: a1, rule: { mode: "percent", value: 50 } });

  const all = await mp.listings(T, "mercadolivre");
  assert.equal(all.total, 5, "só anúncios ML desta empresa");
  assert.deepEqual(all.summary, { total: 5, active: 3, paused: 1, other: 1, unlinked: 1, ownPriceRule: 1, fulfillment: 1 });
  const byCode = Object.fromEntries(all.rows.map((r) => [r.listingId, r]));
  assert.deepEqual([byCode.MLB1.stock.available, byCode.MLB1.stock.desired, byCode.MLB1.stock.ruleSource], [3, 1, "account"], "menor estoque entre canais = 3; 50% = 1");
  assert.equal(byCode.MLB3.stock.state, "fulfillment");
  assert.equal(byCode.MLB4.item, null);
  assert.deepEqual([byCode.MLB1.price.ruleSource, byCode.MLB1.price.ruleText], ["account", "Preço de venda + 10%"]);
  assert.deepEqual([byCode.MLB2.price.ruleSource, byCode.MLB2.price.ruleText, byCode.MLB2.variationId], ["listing", "Preço fixo R$ 389,90", "77"]);
  assert.deepEqual([byCode.MLB9.price.ruleSource, byCode.MLB9.stock.ruleSource], ["default", "default"], "conta B sem regras");

  const codes = async (filters) => (await mp.listings(T, "mercadolivre", filters)).rows.map((r) => r.listingId).sort();
  assert.deepEqual(await codes({ accountId: a2 }), ["MLB9"]);
  assert.deepEqual(await codes({ q: "mesa" }), ["MLB2", "MLB9"], "busca no título");
  assert.deepEqual(await codes({ q: "77" }), ["MLB2"], "busca pela variação");
  assert.deepEqual(await codes({ q: "sofa-1" }), ["MLB1", "MLB3"], "busca pelo SKU");
  assert.deepEqual(await codes({ status: "paused" }), ["MLB2"]);
  assert.deepEqual(await codes({ status: "other" }), ["MLB4"]);
  assert.deepEqual(await codes({ link: "unlinked" }), ["MLB4"]);
  assert.deepEqual(await codes({ priceRule: "listing" }), ["MLB2"]);
  assert.deepEqual(await codes({ priceRule: "account" }), ["MLB1", "MLB3", "MLB4"]);
  assert.deepEqual(await codes({ priceRule: "default" }), ["MLB9"]);
  const page = await mp.listings(T, "mercadolivre", { limit: 2, offset: 2 });
  assert.deepEqual([page.total, page.rows.length], [5, 2], "total vem completo na página");
  assert.equal((await mp.listings(T, "magalu")).total, 1);
});

test("regras da conta: modo, regras e quantos anúncios têm regra própria", opts, async () => {
  const { a1, a2, listing } = await seed();
  const mp = service();
  await mp.savePriceRule({ identity, scope: "listing", targetId: await listing("MLB1"), rule: { adjust: "fixed", value: "999" } });
  await createStockService({ repository: createStockRepository(db) }).saveRule({ identity, scope: "listing", targetId: await listing("MLB2"), rule: { mode: "fixed", value: 3 } });
  const accounts = await mp.rules(T, "mercadolivre");
  assert.deepEqual(accounts.map((a) => a.label), ["LOJA A", "LOJA B"]);
  const a = accounts.find((x) => x.id === String(a1) || Number(x.id) === a1);
  assert.deepEqual([a.mode, a.listings, a.linked, a.listingPriceRules, a.listingStockRules, a.priceRule, a.priceRuleText], ["observe", 4, 3, 1, 1, null, "Preço de venda"]);
  assert.equal(accounts.find((x) => Number(x.id) === a2).listingPriceRules, 0);
  const cards = await mp.overview(T);
  assert.deepEqual(cards.map((c) => [c.id, c.accounts, c.listings, c.unlinked]), [["mercadolivre", 2, 5, 1], ["magalu", 1, 1, 0]]);
});
