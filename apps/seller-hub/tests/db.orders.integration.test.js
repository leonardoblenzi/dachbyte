"use strict";

// Central de pedidos e medição de vendas contra Postgres de verdade (HUB_TEST_DATABASE_URL).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("../src/platform/db");
const { createCatalogRepository } = require("../src/modules/catalog/repository");
const { createCatalogService } = require("../src/modules/catalog/service");
const { createAccountsRepository } = require("../src/modules/accounts/repository");
const { createStockRepository } = require("../src/modules/stock/repository");
const { createOrdersRepository } = require("../src/modules/orders/repository");
const { createOrdersService } = require("../src/modules/orders/service");
const { createBillingService } = require("../src/modules/billing/service");

const url = process.env.HUB_TEST_DATABASE_URL || "";
const opts = { skip: url ? false : "defina HUB_TEST_DATABASE_URL para rodar" };
const db = url ? createDb({ databaseUrl: url, schema: "hub" }) : null;
const T = "tenant-orders";

async function setup(now = () => new Date("2026-11-20T15:00:00Z")) {
  await db.query("truncate hub.items, hub.channel_accounts, hub.locations, hub.audit_events, hub.tenant_settings, hub.webhook_events, hub.gmv_closings restart identity cascade");
  const accounts = createAccountsRepository(db);
  const ml = Number((await accounts.upsertAccount({ tenantId: T, channel: "mercadolivre", externalAccountId: "55", label: "Loja ML", userId: "u" })).id);
  await createCatalogService({ repository: createCatalogRepository(db) }).applyListings({ tenantId: T, accountId: ml, listings: [{ listingId: "MLB1", channelSku: "SOFA-1", stock: 5 }] });
  const repository = createOrdersRepository(db);
  const orders = createOrdersService({ repository, stockRepository: createStockRepository(db) });
  const billing = createBillingService({ repository, now });
  return { ml, orders, billing, repository };
}

const line = (qty = 1, price = 100, fee = 10) => [{ lineKey: "MLB1:", listingId: "MLB1", quantity: qty, unitPrice: price, saleFee: fee }];

test.after(async () => { if (db) await db.close(); });

test("pedido completo: valores calculados, linha do tempo e filtros da central", opts, async () => {
  const { ml, orders } = await setup();
  const account = { id: ml, tenantId: T };
  await orders.ingest(account, { orderId: "A1", status: "open", stage: "paid", orderedAt: "2026-11-10T12:00:00Z", shipBy: new Date(Date.now() - 3600e3).toISOString(), buyer: { name: "Ana" }, lines: line(2, 150, 20) });
  await orders.ingest(account, { orderId: "A1", status: "open", stage: "ready_to_ship", orderedAt: "2026-11-10T12:00:00Z", trackingCode: "BR1", lines: line(2, 150, 20) });
  await orders.ingest(account, { orderId: "A1", status: "open", stage: "ready_to_ship", lines: line(2, 150, 20) });
  await orders.ingest(account, { orderId: "B2", status: "open", stage: "shipped", orderedAt: "2026-11-11T12:00:00Z", lines: line(1, 80, 8) });
  await orders.ingest(account, { orderId: "C3", status: "cancelled", orderedAt: "2026-11-12T12:00:00Z", lines: line(1, 50, 5) });

  const all = await orders.search(T, {});
  assert.equal(all.total, 3);
  const a1 = all.orders.find((o) => o.orderId === "A1");
  assert.deepEqual([a1.productsTotal, a1.feesTotal, a1.netTotal, a1.trackingCode, a1.buyerName, a1.stage], [300, 20, 280, "BR1", "Ana", "ready_to_ship"]);
  assert.deepEqual([all.summary.readyToShip, all.summary.shipped, all.summary.late], [1, 1, 1]);
  assert.deepEqual((await orders.search(T, { due: "late" })).orders.map((o) => o.orderId), ["A1"]);
  assert.deepEqual((await orders.search(T, { stage: "cancelled" })).orders.map((o) => o.orderId), ["C3"]);
  assert.deepEqual((await orders.search(T, { q: "sofa" })).total, 3, "busca pelo SKU do produto");
  assert.deepEqual((await orders.search(T, { q: "BR1" })).orders.map((o) => o.orderId), ["A1"], "busca pelo rastreio");

  const detail = await orders.detail(T, Number(a1.id));
  assert.deepEqual(detail.events.map((e) => [e.kind, e.stage]), [["received", "paid"], ["stock", null], ["stage", "ready_to_ship"]], "repetir sem mudança não cria evento");
  assert.match(detail.events[1].note, /Baixa de estoque/);
  assert.equal(detail.lines[0].sku, "SOFA-1");
  await assert.rejects(() => orders.detail("outra", Number(a1.id)), (e) => e.status === 404);
  const csv = await orders.exportCsv(T, { stage: "shipped" });
  assert.match(csv, /B2;shipped;/);
});

test("vendas do mês: sem frete, cancelado sai, fechamento congela e crédito no mês seguinte", opts, async () => {
  const { ml, orders, billing, repository } = await setup(() => new Date("2026-11-20T15:00:00Z"));
  const account = { id: ml, tenantId: T };
  await orders.ingest(account, { orderId: "O1", status: "open", orderedAt: "2026-10-05T12:00:00Z", productsTotal: 200, shippingPaid: 30, lines: line(2, 100) });
  await orders.ingest(account, { orderId: "O2", status: "open", orderedAt: "2026-10-31T23:30:00-03:00", lines: line(1, 100) });
  await orders.ingest(account, { orderId: "O3", status: "cancelled", orderedAt: "2026-10-10T12:00:00Z", lines: line(1, 70) });
  // 31/10 23:30 em São Paulo é outubro (UTC já é novembro).
  const oct = await billing.month(T, "2026-10");
  assert.deepEqual([oct.orders, oct.gmv, oct.cancelledOrders, oct.credits, oct.base, oct.current], [2, 300, 1, 0, 300, false]);
  assert.deepEqual(await billing.closePastMonths(), { closed: 1 });
  assert.deepEqual(await billing.closePastMonths(), { closed: 0 }, "fecha uma vez só");
  // Cancelamento de pedido de outubro acontece em novembro: crédito em novembro, outubro não muda.
  await orders.ingest(account, { orderId: "O1", status: "cancelled", orderedAt: "2026-10-05T12:00:00Z", lines: line(2, 100) });
  await db.query("update hub.channel_orders set cancelled_at = '2026-11-15T12:00:00Z' where external_order_id = 'O1'");
  await orders.ingest(account, { orderId: "N1", status: "open", orderedAt: "2026-11-02T12:00:00Z", lines: line(3, 100) });
  const nov = await billing.month(T, "2026-11");
  assert.deepEqual([nov.orders, nov.gmv, nov.credits, nov.base, nov.current], [1, 300, 200, 100, true]);
  const closedOct = await billing.month(T, "2026-10");
  assert.deepEqual([closedOct.closing.gmv, closedOct.closing.orders], [300, 2], "fechamento guardado");
  const statement = await billing.statement(T, "2026-11");
  assert.deepEqual(statement.map((r) => [r.orderId, r.kind]).sort(), [["N1", "counted"], ["O1", "credit"]]);
  assert.ok(repository);
});
