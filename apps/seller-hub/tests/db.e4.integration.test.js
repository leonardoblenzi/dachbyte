"use strict";

// E4 contra Postgres de verdade (HUB_TEST_DATABASE_URL): conferência do estoque nos canais,
// divergência explicada por vendas, sobrescrever x avisar, recorrência, trava de ativação e piloto.
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
const { createReconcileRepository } = require("../src/modules/reconcile/repository");
const { createReconcileService } = require("../src/modules/reconcile/service");

const url = process.env.HUB_TEST_DATABASE_URL || "";
const opts = { skip: url ? false : "defina HUB_TEST_DATABASE_URL para rodar" };
const db = url ? createDb({ databaseUrl: url, schema: "hub" }) : null;
const T = "tenant-e4";
const identity = { tenantId: T, userId: "admin" };

async function setup({ canWrite = () => true } = {}) {
  await db.query("truncate hub.items, hub.channel_accounts, hub.locations, hub.audit_events, hub.oauth_states, hub.tenant_settings, hub.webhook_events restart identity cascade");
  const accounts = createAccountsRepository(db);
  const mg = Number((await accounts.upsertAccount({ tenantId: T, channel: "magalu", externalAccountId: "mg", label: "Magalu", userId: "u" })).id);
  const catalog = createCatalogService({ repository: createCatalogRepository(db) });
  await catalog.applyListings({ tenantId: T, accountId: mg, listings: [
    { listingId: "A", channelSku: "A", stock: 10 }, { listingId: "B", channelSku: "B", stock: 6 }, { listingId: "C", channelSku: "C", stock: 4 }, { listingId: "D", channelSku: "D", stock: 2 },
  ] });
  const id = Object.fromEntries((await db.query("select id, sku from hub.items where tenant_id = $1", [T])).rows.map((r) => [r.sku, Number(r.id)]));
  const remote = new Map([["A", 10], ["B", 6], ["C", 4], ["D", 2]]);
  const connector = {
    async readStock(_a, refs) { return refs.map((r) => ({ ref: r.ref, stock: remote.has(r.listingId) ? remote.get(r.listingId) : null })); },
    async writeStock(_a, writes) { return writes.map((w) => { remote.set(w.listingId, w.quantity); return { ref: w.ref, ok: true }; }); },
  };
  const connectors = { has: () => true, get: () => connector, definition: () => ({ capabilities: { listings: true, stockWrite: true } }) };
  const tokens = { getAccessToken: async () => ({ accessToken: "T", externalAccountId: "mg" }) };
  const queued = { push: [], reconcile: [] };
  const queue = { enqueuePush: async (a) => { queued.push.push(a); }, enqueueReconcile: async (job) => { queued.reconcile.push(job); } };
  const stockRepository = createStockRepository(db);
  const sync = createSyncService({ repository: createSyncRepository(db), stockRepository, connectors, tokens, queue, canWrite, verifyDelaysMs: [0], sleep: async () => {} });
  const onItemsChanged = (t, ids, reason) => sync.onItemsChanged(t, ids, reason);
  let polled = 0;
  const orders = createOrdersService({ repository: createOrdersRepository(db), stockRepository, onItemsChanged });
  const reconcile = createReconcileService({ repository: createReconcileRepository(db), connectors, tokens, orders: { pollAccount: async () => { polled += 1; } }, sync, queue });
  const stock = createStockService({ repository: stockRepository, onItemsChanged });
  await stock.applySpreadsheet({ identity, mode: "set", file: { fileName: "s.csv", contentBase64: Buffer.from("sku;quantidade\nA;10\nB;6\nC;4\nD;2\n").toString("base64") } });
  /** Pede e executa uma conferência. */
  const runOnce = async () => {
    const { run } = await reconcile.requestReconcile({ identity, accountId: mg });
    return reconcile.runReconcile({ runId: Number(run.id), tenantId: T, accountId: mg });
  };
  return { mg, id, remote, sync, orders, reconcile, stock, runOnce, queued, polled: () => polled };
}

const divergences = async () => (await db.query("select l.listing_id, d.expected::float, d.observed::float, d.status, d.recurring from hub.stock_divergences d join hub.listings l on l.id = d.listing_id order by d.id")).rows;

test.after(async () => { if (db) await db.close(); });

test("observação: venda recebida explica a queda; mudança por fora vira divergência; só avisa", opts, async () => {
  const { mg, remote, orders, runOnce, polled } = await setup();
  const first = await runOnce();
  assert.deepEqual([first.checked, first.divergences], [4, 0], "tudo igual ao visto na importação");
  assert.equal(polled(), 1, "lê os pedidos antes de comparar");
  // Venda no próprio Magalu: o canal baixa 2 e o Hub recebe o pedido.
  remote.set("A", 8);
  await orders.ingest({ id: mg, tenantId: T }, { orderId: "LU-1", status: "open", lines: [{ lineKey: "A", listingId: "A", quantity: 2 }] });
  // Alguém (Tray, por exemplo) mexeu no B por fora; o C ficou igual.
  remote.set("B", 20);
  const second = await runOnce();
  assert.equal(second.divergences, 1);
  assert.deepEqual(await divergences(), [{ listing_id: "B", expected: 6, observed: 20, status: "open", recurring: false }]);
  assert.equal(Number((await db.queryOne("select channel_stock from hub.listings where listing_id = 'B'")).channel_stock), 20, "guarda o valor visto");
  // Próxima conferência sem mudança nova: não repete a divergência.
  assert.equal((await runOnce()).divergences, 0);
});

test("cancelamento recebido depois explica a volta do estoque no canal", opts, async () => {
  const { mg, remote, orders, runOnce } = await setup();
  await orders.ingest({ id: mg, tenantId: T }, { orderId: "LU-2", status: "open", lines: [{ lineKey: "C", listingId: "C", quantity: 1 }] });
  remote.set("C", 3);
  assert.equal((await runOnce()).divergences, 0);
  await orders.ingest({ id: mg, tenantId: T }, { orderId: "LU-2", status: "cancelled", lines: [{ lineKey: "C", listingId: "C", quantity: 1 }] });
  remote.set("C", 4);
  assert.equal((await runOnce()).divergences, 0, "o canal devolveu ao cancelar; está explicado");
});

test("ativa + sobrescrever: reenvia o valor do Hub; recorrente para de brigar; avisar só registra", opts, async () => {
  const { mg, remote, sync, runOnce, reconcile } = await setup();
  await sync.activateAccount({ identity, accountId: mg, confirm: true });
  remote.set("D", 9);
  const r1 = await runOnce();
  assert.deepEqual([r1.divergences, r1.overwritten], [1, 1]);
  assert.equal((await divergences())[0].status, "overwritten");
  await sync.processAccount(mg);
  assert.equal(remote.get("D"), 2, "o Hub voltou o valor dele no canal");
  // O outro sistema escreve de novo, e de novo: na terceira vez em 24h é recorrente e o Hub só avisa.
  remote.set("D", 9); await runOnce(); await sync.processAccount(mg);
  remote.set("D", 9);
  const r3 = await runOnce();
  assert.deepEqual([r3.divergences, r3.overwritten], [1, 0]);
  const last = (await divergences()).at(-1);
  assert.deepEqual([last.status, last.recurring], ["open", true]);
  // Política "só avisar".
  await reconcile.setPolicy({ identity, accountId: mg, policy: "alert" });
  remote.set("A", 1);
  const r4 = await runOnce();
  assert.deepEqual([r4.divergences, r4.overwritten], [1, 0]);
  // Decisões: reenviar (conta ativa) e ignorar.
  const open = (await reconcile.listDivergences(T, { status: "open" }));
  const a = open.find((d) => d.listingId === "A");
  await reconcile.resolve({ identity, id: Number(a.id), action: "resend" });
  assert.ok((await db.query("select 1 from hub.stock_pushes where state = 'pending'")).rowCount >= 1, "reenvio abriu envio");
  const health = await reconcile.health(T);
  assert.equal(health[0].divergencesRecurring, 1);
  assert.equal(health[0].lastRun.status, "succeeded");
  assert.deepEqual(await reconcile.ignoreAll({ identity, accountId: mg }), { ignored: 1 });
});

test("ativação travada com estoque mudando por fora; piloto libera escrita só para empresas listadas", opts, async () => {
  const blocked = await setup({ canWrite: () => false });
  await assert.rejects(() => blocked.sync.activateAccount({ identity, accountId: blocked.mg, confirm: true }), (e) => e.code === "write_not_enabled");

  const { mg, remote, sync, runOnce, reconcile } = await setup();
  for (const k of ["A", "B", "C"]) remote.set(k, 50);
  assert.equal((await runOnce()).divergences, 3);
  await assert.rejects(() => sync.activateAccount({ identity, accountId: mg, confirm: true }), (e) => e.code === "external_changes" && /3 anúncio/.test(e.message));
  // Em observação não dá para "reenviar": só ignorar.
  const first = (await reconcile.listDivergences(T, {}))[0];
  await assert.rejects(() => reconcile.resolve({ identity, id: Number(first.id), action: "resend" }), (e) => e.code === "divergence_not_found");
  assert.equal((await reconcile.listDivergences(T, {})).length, 3, "tentativa de reenviar não fechou a divergência");
  await reconcile.ignoreAll({ identity, accountId: mg });
  assert.equal((await sync.activateAccount({ identity, accountId: mg, confirm: true })).activated, true);
});

test("conferência: uma por conta; pedido repetido devolve a ativa", opts, async () => {
  const { mg, reconcile, queued } = await setup();
  const a = await reconcile.requestReconcile({ identity, accountId: mg });
  const b = await reconcile.requestReconcile({ identity, accountId: mg });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(queued.reconcile.length, 1);
  assert.deepEqual(await reconcile.scheduleAll(), { queued: 0 }, "agendamento não duplica a que está na fila");
});
