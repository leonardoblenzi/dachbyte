"use strict";

// E3 contra Postgres de verdade (HUB_TEST_DATABASE_URL): venda, cancelamento, kit, Full, venda sem vínculo,
// ativação, envio conferido, divergência, pausa e valor novo durante o envio. Conector falso (sem rede).
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
const { createSyncRepository } = require("../src/modules/sync/repository");
const { createSyncService } = require("../src/modules/sync/service");

const url = process.env.HUB_TEST_DATABASE_URL || "";
const opts = { skip: url ? false : "defina HUB_TEST_DATABASE_URL para rodar" };
const db = url ? createDb({ databaseUrl: url, schema: "hub" }) : null;
const T = "tenant-e3";
const identity = { tenantId: T, userId: "admin" };

/** Canal falso: guarda o "estoque no canal"; dá para forçar divergência, limite e resposta incerta. */
function fakeChannel() {
  const remote = new Map();
  const behavior = { divergeOn: new Set(), rateLimitOnce: new Set(), uncertainOn: new Set(), writes: [] };
  const connector = {
    configured: true,
    async writeStock(_account, writes) {
      return writes.map((w) => {
        behavior.writes.push(w);
        const key = `${w.listingId}:${w.variationId}`;
        if (behavior.rateLimitOnce.has(key)) { behavior.rateLimitOnce.delete(key); return { ref: w.ref, ok: false, retryable: true, error: "limite" }; }
        remote.set(key, behavior.divergeOn.has(key) ? w.quantity + 1 : w.quantity);
        return behavior.uncertainOn.has(key) ? { ref: w.ref, ok: false, uncertain: true, error: "500" } : { ref: w.ref, ok: true };
      });
    },
    async readStock(_account, refs) { return refs.map((r) => ({ ref: r.ref, stock: remote.get(`${r.listingId}:${r.variationId}`) ?? null })); },
  };
  const registry = {
    has: () => true,
    get: () => connector,
    definition: () => ({ capabilities: { listings: true, stockWrite: true, priceWrite: true, orders: true, fulfillment: true } }),
  };
  return { registry, remote, behavior };
}

async function setup() {
  await db.query("truncate hub.items, hub.channel_accounts, hub.locations, hub.audit_events, hub.oauth_states, hub.tenant_settings, hub.webhook_events restart identity cascade");
  const accounts = createAccountsRepository(db);
  const ml = Number((await accounts.upsertAccount({ tenantId: T, channel: "mercadolivre", externalAccountId: "55", label: "ML", userId: "u" })).id);
  const mg = Number((await accounts.upsertAccount({ tenantId: T, channel: "magalu", externalAccountId: "mg", label: "Magalu", userId: "u" })).id);
  const catalog = createCatalogService({ repository: createCatalogRepository(db) });
  await catalog.applyListings({ tenantId: T, accountId: ml, listings: [
    { listingId: "MLB1", channelSku: "SOFA-1", stock: 10 }, { listingId: "MLB2", channelSku: "MESA", stock: 5 },
    { listingId: "MLB9", channelSku: "SOFA-1", stock: 30, fulfillment: true },
  ] });
  await catalog.applyListings({ tenantId: T, accountId: mg, listings: [
    { listingId: "SOFA-1", channelSku: "SOFA-1", stock: 10 }, { listingId: "MESA", channelSku: "MESA", stock: 5 }, { listingId: "SEM-SKU-X", channelSku: null, title: "Anúncio sem SKU", stock: 1 },
  ] });
  const id = Object.fromEntries((await db.query("select id, sku from hub.items where tenant_id = $1", [T])).rows.map((r) => [r.sku, Number(r.id)]));
  const channel = fakeChannel();
  const queued = [];
  const stockRepository = createStockRepository(db);
  const sync = createSyncService({ repository: createSyncRepository(db), stockRepository, connectors: channel.registry,
    tokens: { getAccessToken: async () => ({ accessToken: "T", externalAccountId: "55" }) },
    queue: { enqueuePush: async (accountId) => { queued.push(accountId); } }, verifyDelaysMs: [0, 0], sleep: async () => {} });
  const onItemsChanged = (t, ids, reason) => sync.onItemsChanged(t, ids, reason);
  const orders = createOrdersService({ repository: createOrdersRepository(db), stockRepository, onItemsChanged });
  const stock = createStockService({ repository: stockRepository, onItemsChanged });
  await stock.applySpreadsheet({ identity, mode: "set", file: { fileName: "s.csv", contentBase64: Buffer.from("sku;quantidade\nSOFA-1;10\nMESA;5\n").toString("base64") } });
  for (const [k, v] of [["MLB1:", 10], ["MLB2:", 5], ["SOFA-1:", 10], ["MESA:", 5]]) channel.remote.set(k, v);
  return { ml, mg, id, channel, queued, sync, orders, stock };
}

const onHand = async (itemId) => Number((await db.queryOne("select on_hand from hub.stock_balances where item_id = $1", [itemId]))?.on_hand ?? NaN);
const pushes = async () => (await db.query("select p.state, p.desired::float as desired, p.observed::float as observed, l.listing_id from hub.stock_pushes p join hub.listings l on l.id = p.listing_id order by p.id")).rows;

test.after(async () => { if (db) await db.close(); });

test("venda baixa, cancelamento devolve, repetição não duplica; Full e sem vínculo não baixam", opts, async () => {
  const { ml, mg, id, orders } = await setup();
  const sale = { orderId: "2001", status: "open", lines: [{ lineKey: "MLB1:", listingId: "MLB1", quantity: 2 }, { lineKey: "MLB9:", listingId: "MLB9", quantity: 1 }] };
  await orders.ingest({ id: ml, tenantId: T }, sale);
  await orders.ingest({ id: ml, tenantId: T }, sale);
  assert.equal(await onHand(id["SOFA-1"]), 8, "2 vendidos; Full (MLB9) não mexe no estoque central; repetir o pedido não baixa de novo");
  await orders.ingest({ id: ml, tenantId: T }, { ...sale, status: "cancelled" });
  await orders.ingest({ id: ml, tenantId: T }, { ...sale, status: "cancelled" });
  assert.equal(await onHand(id["SOFA-1"]), 10, "cancelamento devolve uma vez só");
  const kinds = (await db.query("select kind, quantity::float from hub.stock_movements where item_id = $1 and source_type = 'order' order by id", [id["SOFA-1"]])).rows;
  assert.deepEqual(kinds.map((k) => [k.kind, k.quantity]), [["sale", -2], ["cancellation", 2]]);

  // Venda de anúncio sem vínculo fica pendente e baixa na hora em que vincular.
  await orders.ingest({ id: mg, tenantId: T }, { orderId: "LU-9", status: "open", lines: [{ lineKey: "SEM-SKU-X", listingId: "SEM-SKU-X", quantity: 3 }] });
  const pending = await orders.listOrders(T, { pendingOnly: true });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].lines[0].pending, true);
  const listing = Number((await db.queryOne("select id from hub.listings where listing_id = 'SEM-SKU-X'")).id);
  await createCatalogService({ repository: createCatalogRepository(db) }).linkListing(T, listing, id.MESA);
  const applied = await orders.applyPendingForListing(T, listing);
  assert.deepEqual(applied, { orders: 1, movements: 1 });
  assert.equal(await onHand(id.MESA), 2);
  assert.equal((await orders.listOrders(T, { pendingOnly: true })).length, 0);
});

test("kit vendido baixa os componentes; venda deixa negativo visível", opts, async () => {
  const { ml, id, orders, stock } = await setup();
  await db.query("insert into hub.items (tenant_id, sku, sku_key, name, origin) values ($1, 'KIT', 'kit', 'Kit', 'manual')", [T]);
  const kit = Number((await db.queryOne("select id from hub.items where sku = 'KIT'")).id);
  await stock.setKit({ identity, itemId: kit, components: [{ sku: "SOFA-1", quantity: 1 }, { sku: "MESA", quantity: 2 }] });
  await db.query("update hub.listings set item_id = $1 where listing_id = 'MLB2'", [kit]);
  await orders.ingest({ id: ml, tenantId: T }, { orderId: "K1", status: "open", lines: [{ lineKey: "MLB2:", listingId: "MLB2", quantity: 3 }] });
  assert.deepEqual([await onHand(id["SOFA-1"]), await onHand(id.MESA)], [7, -1], "3 kits = 3 sofás e 6 mesas (tinha 5)");
});

test("ativação envia o que difere e confere; venda gera envio para as outras contas ativas", opts, async () => {
  const { ml, mg, id, channel, queued, sync, orders } = await setup();
  await assert.rejects(() => sync.activateAccount({ identity, accountId: mg, confirm: false }), (e) => e.code === "confirmation_required");
  await createStockService({ repository: createStockRepository(db) }).saveRule({ identity, scope: "account", targetId: mg, rule: { mode: "percent", value: 50 } });
  const act = await sync.activateAccount({ identity, accountId: mg, confirm: true });
  assert.equal(act.pushes, 2, "50% de 10 = 5 e 50% de 5 = 2 (canal tem 10 e 5)");
  assert.deepEqual(queued, [mg]);
  const run = await sync.processAccount(mg);
  assert.equal(run.verified, 2);
  assert.deepEqual((await pushes()).map((p) => [p.listing_id, p.state, p.desired, p.observed]), [["MESA", "verified", 2, 2], ["SOFA-1", "verified", 5, 5]]);
  assert.equal(Number((await db.queryOne("select channel_stock from hub.listings where listing_id = 'SOFA-1'")).channel_stock), 5);

  // Venda no ML (conta em observação): baixa o central e gera envio só para a conta ativa (Magalu).
  await orders.ingest({ id: ml, tenantId: T }, { orderId: "3001", status: "open", lines: [{ lineKey: "MLB1:", listingId: "MLB1", quantity: 4 }] });
  assert.equal(await onHand(id["SOFA-1"]), 6);
  const open = (await pushes()).filter((p) => p.state === "pending");
  assert.deepEqual(open.map((p) => [p.listing_id, p.desired]), [["SOFA-1", 3]], "50% de 6 = 3; ML em observação não recebe envio");
  await sync.processAccount(mg);
  assert.equal(channel.remote.get("SOFA-1:"), 3);
});

test("divergência, limite do canal, resposta incerta, pausa geral e valor novo durante o envio", opts, async () => {
  const { mg, id, channel, sync, stock } = await setup();
  channel.behavior.divergeOn.add("SOFA-1:");
  channel.behavior.rateLimitOnce.add("MESA:");
  await stock.adjust({ identity, itemId: id.MESA, op: "set", quantity: 4, note: "contagem" });
  await stock.adjust({ identity, itemId: id["SOFA-1"], op: "set", quantity: 9, note: "contagem" });
  await sync.activateAccount({ identity, accountId: mg, confirm: true });
  const first = await sync.processAccount(mg);
  assert.deepEqual([first.divergent, first.retry], [1, 1]);
  const rows = await pushes();
  assert.ok(rows.some((p) => p.listing_id === "SOFA-1" && p.state === "divergent" && p.observed === 10), "canal mostra 10, Hub mandou 9: divergente, não reenvia sozinho");
  assert.ok(rows.some((p) => p.listing_id === "MESA" && p.state === "pending"), "limite do canal: volta para a fila");

  // Pausa geral: nada sai.
  await sync.setPaused({ identity, paused: true });
  assert.deepEqual(await sync.processAccount(mg), { paused: true });
  assert.ok((await pushes()).some((p) => p.listing_id === "MESA" && p.state === "pending"));
  await sync.setPaused({ identity, paused: false });
  await sync.processAccount(mg);
  assert.ok((await pushes()).some((p) => p.listing_id === "MESA" && p.state === "verified"));

  // Resposta incerta: confere relendo; bateu = conferido (nunca reenvia às cegas).
  channel.behavior.uncertainOn.add("MESA:");
  await stock.adjust({ identity, itemId: id.MESA, op: "add", quantity: 1, note: "entrada" });
  await sync.processAccount(mg);
  assert.equal((await pushes()).filter((p) => p.listing_id === "MESA").at(-1).state, "verified");

  // Valor novo enquanto o envio está em andamento: vira o próximo envio.
  await stock.adjust({ identity, itemId: id.MESA, op: "add", quantity: 1, note: "entrada" });
  await db.query("update hub.stock_pushes set state = 'sending' where state = 'pending'");
  await stock.adjust({ identity, itemId: id.MESA, op: "add", quantity: 1, note: "entrada" });
  const sending = await db.queryOne("select id, desired::float, followup::float from hub.stock_pushes where state = 'sending'");
  assert.deepEqual([sending.desired, sending.followup], [6, 7]);
  const done = await createSyncRepository(db).finish(Number(sending.id), { state: "verified", observed: 6 });
  assert.equal(done.followup, true);
  assert.equal((await db.queryOne("select desired::float from hub.stock_pushes where state = 'pending'")).desired, 7);

  // Saiu do modo ativo: pendentes cancelados.
  assert.equal(await sync.skipPending(mg, "teste"), 1);
});

test("webhook guardado uma vez por dedupe_key; processado busca o pedido e aplica", opts, async () => {
  const { ml, id } = await setup();
  const repo = createOrdersRepository(db);
  const first = await repo.insertWebhook({ channel: "mercadolivre", externalAccountId: "55", topic: "order", resourceId: "777", dedupeKey: "mercadolivre:x1", payload: {} });
  const again = await repo.insertWebhook({ channel: "mercadolivre", externalAccountId: "55", topic: "order", resourceId: "777", dedupeKey: "mercadolivre:x1", payload: {} });
  assert.ok(first);
  assert.equal(again, null);
  const connector = { getOrder: async (_a, orderId) => ({ orderId, status: "open", lines: [{ lineKey: "MLB1:", listingId: "MLB1", quantity: 1 }] }) };
  const orders = createOrdersService({ repository: repo, stockRepository: createStockRepository(db), connectors: { get: () => connector }, tokens: { getAccessToken: async () => ({ accessToken: "T", externalAccountId: "55" }) } });
  await orders.processWebhook(Number(first.id));
  assert.equal(await onHand(id["SOFA-1"]), 9);
  assert.equal((await db.queryOne("select status from hub.webhook_events where id = $1", [first.id])).status, "processed");
  assert.deepEqual(await orders.processWebhook(Number(first.id)), { skipped: true });
  const other = await repo.insertWebhook({ channel: "mercadolivre", externalAccountId: "999", topic: "order", resourceId: "1", dedupeKey: "mercadolivre:x2", payload: {} });
  assert.deepEqual(await orders.processWebhook(Number(other.id)), { ignored: true }, "conta que não está no Hub");
  assert.ok(ml);
});
