"use strict";

// Expedição contra Postgres de verdade (HUB_TEST_DATABASE_URL): lote, lista de separação, conferência, foto, coleta.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("../src/platform/db");
const { createCatalogRepository } = require("../src/modules/catalog/repository");
const { createCatalogService } = require("../src/modules/catalog/service");
const { createAccountsRepository } = require("../src/modules/accounts/repository");
const { createStockRepository } = require("../src/modules/stock/repository");
const { createStockService } = require("../src/modules/stock/service");
const { createOrdersRepository } = require("../src/modules/orders/repository");
const { createOrdersService } = require("../src/modules/orders/service");
const { createAutomationsRepository } = require("../src/modules/automations/repository");
const { createAutomationsService } = require("../src/modules/automations/service");
const { createExpeditionRepository } = require("../src/modules/expedition/repository");
const { createExpeditionService } = require("../src/modules/expedition/service");

const url = process.env.HUB_TEST_DATABASE_URL || "";
const opts = { skip: url ? false : "defina HUB_TEST_DATABASE_URL para rodar" };
const db = url ? createDb({ databaseUrl: url, schema: "hub" }) : null;
const T = "tenant-exp";
const identity = { tenantId: T, userId: "operador" };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString("base64");

async function setup() {
  await db.query("truncate hub.items, hub.channel_accounts, hub.locations, hub.audit_events, hub.tenant_settings, hub.order_statuses, hub.automation_rules, hub.notifications, hub.picking_batches, hub.pickups restart identity cascade");
  const ml = Number((await createAccountsRepository(db).upsertAccount({ tenantId: T, channel: "mercadolivre", externalAccountId: "55", label: "Loja ML", userId: "u" })).id);
  await createCatalogService({ repository: createCatalogRepository(db) }).applyListings({ tenantId: T, accountId: ml, listings: [
    { listingId: "MLB1", channelSku: "SOFA-1", ean: "7891234567895" }, { listingId: "MLB2", channelSku: "MESA" }, { listingId: "MLB3", channelSku: "KIT-SALA" },
  ] });
  const stock = createStockService({ repository: createStockRepository(db) });
  const kitId = Number((await db.queryOne("select id from hub.items where sku = 'KIT-SALA'")).id);
  await stock.setKit({ identity: { tenantId: T, userId: "u" }, itemId: kitId, components: [{ sku: "SOFA-1", quantity: 1 }, { sku: "MESA", quantity: 2 }] });
  const automations = createAutomationsService({ repository: createAutomationsRepository(db) });
  const orders = createOrdersService({ repository: createOrdersRepository(db), stockRepository: createStockRepository(db) });
  const expedition = createExpeditionService({ repository: createExpeditionRepository(db), onOrderPacked: (e) => automations.orderPacked(e) });
  const account = { id: ml, tenantId: T };
  const soon = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  await orders.ingest(account, { orderId: "P1", status: "open", stage: "paid", shipBy: soon(2), trackingCode: "BR111", lines: [{ lineKey: "a", listingId: "MLB1", quantity: 1 }, { lineKey: "b", listingId: "MLB3", quantity: 1 }] });
  await orders.ingest(account, { orderId: "P2", status: "open", stage: "paid", shipBy: soon(-1), lines: [{ lineKey: "a", listingId: "MLB1", quantity: 1 }] });
  await orders.ingest(account, { orderId: "P3", status: "open", stage: "ready_to_ship", shipBy: soon(30), lines: [{ lineKey: "a", listingId: "MLB2", quantity: 2 }] });
  await orders.ingest(account, { orderId: "F1", status: "open", stage: "paid", fulfillment: true, lines: [{ lineKey: "a", listingId: "MLB1", quantity: 1 }] });
  const id = async (orderId) => Number((await db.queryOne("select id from hub.channel_orders where external_order_id = $1", [orderId])).id);
  return { expedition, automations, id };
}

test.after(async () => { if (db) await db.close(); });

test("fila, lote e lista de separação (kit aberto, Full fora); fechar lote devolve o que faltou", opts, async () => {
  const { expedition, id } = await setup();
  const queue = await expedition.queue(T);
  assert.deepEqual(queue.map((o) => o.orderId), ["P2", "P1", "P3"], "mais urgente primeiro; Full não entra");
  assert.deepEqual((await expedition.queue(T, { due: "late" })).map((o) => o.orderId), ["P2"]);
  const batch = await expedition.createBatch({ identity, orderIds: [await id("P1"), await id("P2"), await id("F1")] });
  assert.equal(batch.orders, 2, "Full fica de fora do lote");
  const p1 = await id("P1");
  await assert.rejects(() => expedition.createBatch({ identity, orderIds: [p1] }), (e) => e.code === "nothing_to_pick");
  const b = await expedition.getBatch(T, batch.id);
  assert.deepEqual(b.picking.map((r) => [r.sku, r.quantity, r.orders]), [["MESA", 2, 1], ["SOFA-1", 3, 2]], "P1 = 1 sofá + kit(1 sofá + 2 mesas); P2 = 1 sofá");
  assert.deepEqual((await expedition.summary(T)), { toPick: 1, inBatch: 2, packed: 0, packedNoPickup: 0, late: 1, issues: 0 });
  assert.deepEqual(await expedition.closeBatch(T, batch.id), { id: batch.id, returned: 2 });
  assert.equal((await expedition.queue(T)).length, 3, "voltaram para a fila");
});

test("conferência: pelo rastreio, contagem obrigatória, foto guardada, automação 'pedido conferido'", opts, async () => {
  const { expedition, automations, id } = await setup();
  await automations.saveRule({ identity, input: { name: "Conferido", event: "order_packed", actions: [{ type: "add_tag", tag: "Embalado" }] } });
  const c = await expedition.lookup(T, "BR111");
  assert.equal(c.order.orderId, "P1");
  assert.deepEqual(c.units.map((u) => [u.sku, u.quantity]), [["SOFA-1", 2], ["MESA", 2]]);
  assert.equal((await expedition.matchUnit(T, Number(c.order.id), "7891234567895")).key, `item:${c.units[0].itemId}`);
  await assert.rejects(() => expedition.matchUnit(T, Number(c.order.id), "XPTO"), (e) => e.code === "code_not_in_order");
  const sofa = c.units[0].key, mesa = c.units[1].key;
  await assert.rejects(() => expedition.pack({ identity, orderId: Number(c.order.id), checks: [{ key: sofa, scanned: 1 }, { key: mesa, scanned: 2 }] }), (e) => e.code === "count_mismatch");
  const packed = await expedition.pack({ identity, orderId: Number(c.order.id), checks: [{ key: sofa, scanned: 1, manual: 1 }, { key: mesa, scanned: 2 }], photoBase64: JPEG });
  assert.ok(packed.photoId);
  const photo = await expedition.photo(T, packed.photoId);
  assert.equal(photo.mime, "image/jpeg");
  await assert.rejects(() => expedition.photo("outra", packed.photoId), (e) => e.status === 404, "foto de outra empresa não abre");
  await assert.rejects(() => expedition.pack({ identity, orderId: Number(c.order.id), checks: [{ key: sofa, scanned: 2 }, { key: mesa, scanned: 2 }] }), (e) => e.code === "already_packed");
  assert.deepEqual((await db.queryOne("select tags from hub.channel_orders where external_order_id = 'P1'")).tags, ["Embalado"], "automação do gatilho novo rodou");
  const note = (await db.queryOne("select note from hub.order_events where order_id = $1 and kind = 'expedition' order by id desc limit 1", [Number(c.order.id)])).note;
  assert.match(note, /Conferido: 4 unidade\(s\), 1 sem código, com foto/);

  // Por produto: bipou o sofá → pedido de 1 unidade (P2); depois não há outro.
  const next = await expedition.nextForProduct(T, "7891234567895");
  assert.equal(next.order.orderId, "P2");
  await expedition.pack({ identity, orderId: Number(next.order.id), checks: [{ key: next.units[0].key, scanned: 1 }] });
  await assert.rejects(() => expedition.nextForProduct(T, "7891234567895"), (e) => e.code === "order_not_found");

  // Problema e desfazer.
  await expedition.reportIssue({ identity, orderId: await id("P3"), note: "falta 1 mesa" });
  assert.equal((await expedition.summary(T)).issues, 1);
  await expedition.unpack({ identity, orderId: await id("P2") });
  assert.equal((await expedition.summary(T)).packed, 1);
});

test("coleta: só embarca conferido, não repete, fecha e marca como entregue", opts, async () => {
  const { expedition, id } = await setup();
  const c = await expedition.lookup(T, "P2");
  await expedition.pack({ identity, orderId: Number(c.order.id), checks: [{ key: c.units[0].key, scanned: 1 }] });
  const pickup = await expedition.createPickup({ identity, carrier: "Mercado Envios (coleta)", scheduledFor: "2026-11-06" });
  await assert.rejects(() => expedition.scanToPickup({ identity, pickupId: Number(pickup.id), code: "P3" }), /ainda não foi conferido/);
  await expedition.scanToPickup({ identity, pickupId: Number(pickup.id), code: "P2" });
  await assert.rejects(() => expedition.scanToPickup({ identity, pickupId: Number(pickup.id), code: "P2" }), /já está nesta coleta/);
  assert.equal((await expedition.getPickup(T, Number(pickup.id))).orders.length, 1);
  assert.deepEqual(await expedition.closePickup({ identity, pickupId: Number(pickup.id) }), { id: Number(pickup.id), orders: 1 });
  assert.ok((await db.queryOne("select handed_over_at from hub.channel_orders where id = $1", [await id("P2")])).handed_over_at);
  await assert.rejects(() => expedition.scanToPickup({ identity, pickupId: Number(pickup.id), code: "P2" }), /Coleta fechada/);
  const p2 = await id("P2");
  await assert.rejects(() => expedition.unpack({ identity, orderId: p2 }), (e) => e.code === "cannot_unpack", "entregue não desfaz");
  await assert.rejects(() => expedition.createPickup({ identity, carrier: "", scheduledFor: "2026-11-06" }), (e) => e.code === "carrier_required");
  // Pedido já entregue (ou Full) não é conferido.
  await db.query("update hub.channel_orders set stage = 'delivered' where external_order_id = 'P3'");
  const p3 = await expedition.lookup(T, "P3");
  await assert.rejects(() => expedition.pack({ identity, orderId: Number(p3.order.id), checks: [{ key: p3.units[0].key, scanned: 2 }] }), (e) => e.code === "already_packed");
});
