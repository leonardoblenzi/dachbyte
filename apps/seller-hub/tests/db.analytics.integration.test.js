"use strict";

// Análise (A1) contra Postgres de verdade (HUB_TEST_DATABASE_URL): vendas por canal/conta e mais vendidos multicanal.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("../src/platform/db");
const { createCatalogRepository } = require("../src/modules/catalog/repository");
const { createCatalogService } = require("../src/modules/catalog/service");
const { createAccountsRepository } = require("../src/modules/accounts/repository");
const { createStockRepository } = require("../src/modules/stock/repository");
const { createOrdersRepository } = require("../src/modules/orders/repository");
const { createOrdersService } = require("../src/modules/orders/service");
const { createAnalyticsRepository } = require("../src/modules/analytics/repository");
const { createAnalyticsService } = require("../src/modules/analytics/service");

const url = process.env.HUB_TEST_DATABASE_URL || "";
const opts = { skip: url ? false : "defina HUB_TEST_DATABASE_URL para rodar" };
const db = url ? createDb({ databaseUrl: url, schema: "hub" }) : null;
const T = "tenant-analytics";

async function setup() {
  await db.query("truncate hub.items, hub.channel_accounts, hub.locations, hub.audit_events, hub.tenant_settings, hub.webhook_events, hub.gmv_closings restart identity cascade");
  const accounts = createAccountsRepository(db);
  const ml = Number((await accounts.upsertAccount({ tenantId: T, channel: "mercadolivre", externalAccountId: "55", label: "Loja ML", userId: "u" })).id);
  const sh = Number((await accounts.upsertAccount({ tenantId: T, channel: "shopee", externalAccountId: "77", label: "Loja Shopee", userId: "u" })).id);
  const catalog = createCatalogService({ repository: createCatalogRepository(db) });
  await catalog.applyListings({ tenantId: T, accountId: ml, listings: [{ listingId: "MLB1", channelSku: "SOFA-1", stock: 50 }, { listingId: "MLB2", channelSku: "MESA-1", stock: 50 }] });
  await catalog.applyListings({ tenantId: T, accountId: sh, listings: [{ listingId: "SH1", channelSku: "SOFA-1", stock: 50 }] });
  const orders = createOrdersService({ repository: createOrdersRepository(db), stockRepository: createStockRepository(db) });
  const analytics = createAnalyticsService({ repository: createAnalyticsRepository(db), now: () => new Date("2026-11-20T15:00:00Z") });
  return { ml, sh, orders, analytics };
}

/** @param {string} listingId @param {number} qty @param {number} price */
const line = (listingId, qty, price) => [{ lineKey: `${listingId}:`, listingId, quantity: qty, unitPrice: price }];

test.after(async () => { if (db) await db.close(); });

test("vendas por canal e conta: cancelado fora do faturamento, comparação com o período anterior", opts, async () => {
  const { ml, sh, orders, analytics } = await setup();
  const ML = { id: ml, tenantId: T }, SH = { id: sh, tenantId: T };
  await orders.ingest(ML, { orderId: "A1", status: "open", stage: "paid", orderedAt: "2026-11-10T12:00:00Z", productsTotal: 300, lines: line("MLB1", 2, 150) });
  await orders.ingest(ML, { orderId: "A2", status: "cancelled", stage: "cancelled", orderedAt: "2026-11-11T12:00:00Z", productsTotal: 100, lines: line("MLB2", 1, 100) });
  await orders.ingest(SH, { orderId: "S1", status: "open", stage: "shipped", orderedAt: "2026-11-12T12:00:00Z", productsTotal: 140, lines: line("SH1", 1, 140) });
  // Período anterior (01/11 a 10/11 → anterior 22/10 a 31/10).
  await orders.ingest(ML, { orderId: "OLD", status: "open", stage: "delivered", orderedAt: "2026-10-25T12:00:00Z", productsTotal: 150, lines: line("MLB1", 1, 150) });

  const r = await analytics.sales(T, { from: "2026-11-01", to: "2026-11-20" });
  assert.equal(r.totals.orders, 2);
  assert.equal(r.totals.gmv, 440);
  assert.equal(r.totals.cancelledOrders, 1);
  assert.equal(r.totals.cancelRate, 33.3);
  assert.equal(r.totals.previous.gmv, 150);
  assert.deepEqual(r.channels.map((c) => [c.channel, c.gmv, c.share]), [["mercadolivre", 300, 68.2], ["shopee", 140, 31.8]]);
  assert.equal(r.accounts.find((a) => a.channel === "mercadolivre").change.gmv, 100);

  const onlyShopee = await analytics.sales(T, { from: "2026-11-01", to: "2026-11-20", channel: "shopee" });
  assert.deepEqual(onlyShopee.accounts.map((a) => a.account), ["Loja Shopee"]);
});

test("mais vendidos: mesmo produto somado entre canais, venda sem vínculo pelo SKU do canal, curva ABC", opts, async () => {
  const { ml, sh, orders, analytics } = await setup();
  const ML = { id: ml, tenantId: T }, SH = { id: sh, tenantId: T };
  await orders.ingest(ML, { orderId: "A1", status: "open", stage: "paid", orderedAt: "2026-11-10T12:00:00Z", lines: line("MLB1", 2, 150) });
  await orders.ingest(SH, { orderId: "S1", status: "open", stage: "paid", orderedAt: "2026-11-11T12:00:00Z", lines: line("SH1", 1, 100) });
  await orders.ingest(ML, { orderId: "A2", status: "open", stage: "paid", orderedAt: "2026-11-12T12:00:00Z", lines: line("MLB2", 1, 60) });
  await orders.ingest(SH, { orderId: "S2", status: "open", stage: "paid", orderedAt: "2026-11-12T12:00:00Z", lines: [{ lineKey: "SH9:", listingId: "SH9", channelSku: "NOVO-9", quantity: 3, unitPrice: 10 }] });
  await orders.ingest(SH, { orderId: "S3", status: "open", stage: "paid", orderedAt: "2026-11-13T12:00:00Z", productsTotal: 25, lines: [{ lineKey: "SH9:", listingId: "SH9", channelSku: "NOVO-9", quantity: 1 }] });
  await orders.ingest(ML, { orderId: "A3", status: "cancelled", stage: "cancelled", orderedAt: "2026-11-12T12:00:00Z", lines: line("MLB2", 5, 60) });

  const r = await analytics.products(T, { from: "2026-11-01", to: "2026-11-20" });
  assert.deepEqual(r.products.map((p) => [p.sku, p.units, p.revenue, p.abc]), [["SOFA-1", 3, 400, "A"], ["MESA-1", 1, 60, "A"], ["NOVO-9", 4, 55, "B"]]);
  // S3 vem sem preço unitário: usa o total do pedido (25). Acumulado antes de cada item: 0%, 77,7% (A) e 89,3% (B).
  assert.deepEqual(r.products[0].channels.map((c) => [c.channel, c.share]), [["mercadolivre", 75], ["shopee", 25]]);
  assert.equal(r.products[2].pending, true);
  assert.deepEqual(r.pending, { products: 1, revenue: 55 });

  const byUnits = await analytics.products(T, { from: "2026-11-01", to: "2026-11-20", sort: "units" });
  assert.deepEqual(byUnits.products.map((p) => p.sku), ["NOVO-9", "SOFA-1", "MESA-1"]);
  const csv = await analytics.productsCsv(T, { from: "2026-11-01", to: "2026-11-20" });
  assert.match(csv.split("\r\n")[1], /^1;SOFA-1;.*;A;3;2;400,00;/);
});
