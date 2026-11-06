"use strict";

// Integração com Postgres de verdade. Roda só com HUB_TEST_DATABASE_URL (banco descartável, migrations aplicadas):
//   HUB_TEST_DATABASE_URL=postgres://... npm run test:db
// Cada teste apaga os dados do schema hub antes de começar.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("../src/platform/db");
const { createCatalogRepository } = require("../src/modules/catalog/repository");
const { createCatalogService } = require("../src/modules/catalog/service");
const { createAccountsRepository } = require("../src/modules/accounts/repository");
const { createImportsRepository } = require("../src/modules/imports/repository");
const { createStockRepository } = require("../src/modules/stock/repository");
const { createStockService } = require("../src/modules/stock/service");

const url = process.env.HUB_TEST_DATABASE_URL || "";
const opts = { skip: url ? false : "defina HUB_TEST_DATABASE_URL para rodar" };
const db = url ? createDb({ databaseUrl: url, schema: "hub" }) : null;
const T = "tenant-a";

async function reset() {
  await db.query(`truncate hub.items, hub.channel_accounts, hub.locations, hub.audit_events, hub.oauth_states restart identity cascade`);
}

/** Conta conectada com anúncios vinculados a SOFA-1, MESA e (Full) SOFA-1. */
async function seed() {
  await reset();
  const accounts = createAccountsRepository(db);
  const ml = await accounts.upsertAccount({ tenantId: T, channel: "mercadolivre", externalAccountId: "111", label: "Loja ML", userId: "u1" });
  const mg = await accounts.upsertAccount({ tenantId: T, channel: "magalu", externalAccountId: "mg-1", label: "Loja Magalu", userId: "u1" });
  const catalog = createCatalogService({ repository: createCatalogRepository(db) });
  await catalog.applyListings({ tenantId: T, accountId: ml.id, listings: [
    { listingId: "MLB1", channelSku: "SOFA-1", title: "Sofá", stock: 6 },
    { listingId: "MLB2", channelSku: "MESA", title: "Mesa", stock: 2 },
    { listingId: "MLB3", channelSku: "SOFA-1", title: "Sofá Full", stock: 50, fulfillment: true },
  ] });
  await catalog.applyListings({ tenantId: T, accountId: mg.id, listings: [
    { listingId: "S-SOFA", channelSku: "sofa 1", title: "Sofá", stock: 4 },
    { listingId: "S-MESA", channelSku: "MESA", title: "Mesa", stock: 9 },
  ] });
  const items = (await db.query("select id, sku from hub.items where tenant_id = $1 order by sku", [T])).rows;
  const id = Object.fromEntries(items.map((r) => [r.sku, Number(r.id)]));
  return { ml: Number(ml.id), mg: Number(mg.id), id };
}

test.after(async () => { if (db) await db.close(); });

test("contas novas começam em observação e a importação registra progresso e conclusão", opts, async () => {
  const { ml } = await seed();
  const mode = await db.queryOne("select stock_sync_mode from hub.channel_accounts where id = $1", [ml]);
  assert.equal(mode.stock_sync_mode, "observe");
  const imports = createImportsRepository(db);
  const first = await imports.createRun({ accountId: ml, trigger: "manual", userId: "u1" });
  const again = await imports.createRun({ accountId: ml, trigger: "manual", userId: "u1" });
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(Number(again.run.id), Number(first.run.id));
  assert.equal((await imports.markRunning(Number(first.run.id), "outro-tenant")), null, "outra empresa não assume");
  const running = await imports.markRunning(Number(first.run.id), T);
  assert.equal(running.channel, "mercadolivre");
  await imports.progress(Number(first.run.id), { pages: 1, listingsSeen: 3, linkedAuto: 3, unlinked: 0 });
  await imports.finish(Number(first.run.id), { status: "succeeded", pages: 2, listingsSeen: 3, linkedAuto: 3, unlinked: 0 });
  const listed = (await createAccountsRepository(db).listAccounts(T)).find((a) => Number(a.id) === ml);
  assert.equal(listed.lastImport.status, "succeeded");
  assert.equal(listed.lastImport.pages, 2);
  assert.ok(listed.lastImportAt, "last_import_at preenchido");
  assert.equal((await imports.createRun({ accountId: ml, trigger: "manual" })).created, true, "depois de concluir, pode importar de novo");
  // Execução presa: heartbeat antigo é encerrada no próximo pedido.
  await db.query("update hub.import_runs set heartbeat_at = now() - interval '1 hour' where status in ('queued','running')");
  const recovered = await imports.createRun({ accountId: ml, trigger: "manual" });
  assert.equal(recovered.created, true);
  assert.equal((await db.queryOne("select count(*)::int as n from hub.import_runs where status = 'failed'")).n, 1);
});

test("ledger: definir e somar, saldo = soma dos movimentos, idempotência e bloqueio de negativo", opts, async () => {
  const { id } = await seed();
  const repo = createStockRepository(db);
  const r1 = await repo.applyEntries(T, [{ itemId: id["SOFA-1"], op: "set", quantity: 10, kind: "initial" }, { itemId: id.MESA, op: "set", quantity: 0, kind: "initial" }], { userId: "u1" });
  assert.equal(r1.applied, 1, "MESA = 0 não gera movimento, mas fica com estoque informado");
  assert.equal(r1.unchanged, 1);
  await repo.applyEntries(T, [{ itemId: id["SOFA-1"], op: "add", quantity: -3, kind: "adjustment", note: "avaria", idempotencyKey: "k1" }]);
  const dup = await repo.applyEntries(T, [{ itemId: id["SOFA-1"], op: "add", quantity: -3, kind: "adjustment", idempotencyKey: "k1" }]);
  assert.equal(dup.duplicates, 1);
  await assert.rejects(() => repo.applyEntries(T, [{ itemId: id.MESA, op: "add", quantity: -1, kind: "adjustment" }]), (e) => e.code === "negative_stock");
  const bal = await db.query("select item_id, on_hand::float from hub.stock_balances order by item_id");
  assert.deepEqual(bal.rows.map((r) => [Number(r.item_id), r.on_hand]), [[id.MESA, 0], [id["SOFA-1"], 7]].sort((a, b) => a[0] - b[0]));
  const sums = await db.query(`select b.item_id, b.on_hand::float as on_hand, coalesce(sum(m.quantity), 0)::float as total
                                 from hub.stock_balances b left join hub.stock_movements m on m.item_id = b.item_id group by b.item_id, b.on_hand`);
  for (const row of sums.rows) assert.equal(row.on_hand, row.total, "saldo igual à soma do ledger");
  const last = await db.queryOne("select balance_after::float, note from hub.stock_movements order by id desc limit 1");
  assert.deepEqual([last.balance_after, last.note], [7, "avaria"]);
});

test("serviço: estoque inicial pelo menor canal, kit, regras e 'o que mudaria'", opts, async () => {
  const { ml, mg, id } = await seed();
  const stock = createStockService({ repository: createStockRepository(db) });
  const identity = { tenantId: T, userId: "u1" };

  const preview = await stock.initialFromChannels({ identity, source: "lowest" });
  assert.equal(preview.count, 2);
  await stock.initialFromChannels({ identity, source: "lowest", apply: true });
  const listed = await stock.listStock(T, {});
  const by = Object.fromEntries(listed.items.map((i) => [i.sku, i]));
  assert.equal(by["SOFA-1"].available, 4, "menor entre 6 (ML) e 4 (Magalu); Full fica de fora");
  assert.equal(by.MESA.available, 2);
  assert.equal(listed.summary.missing, 0);

  // Kit: novo item sem estoque vira kit de 2 SOFA-1 + 1 MESA → disponível = min(4/2, 2/1) = 2.
  await db.query("insert into hub.items (tenant_id, sku, sku_key, name, origin) values ($1, 'KIT-SALA', 'kit-sala', 'Kit sala', 'manual')", [T]);
  const kitId = Number((await db.queryOne("select id from hub.items where sku = 'KIT-SALA'")).id);
  await stock.setKit({ identity, itemId: kitId, components: [{ sku: "SOFA-1", quantity: 2 }, { sku: "MESA", quantity: 1 }] });
  assert.equal((await stock.listStock(T, { filter: "kits" })).items[0].available, 2);
  await assert.rejects(() => stock.adjust({ identity, itemId: kitId, op: "add", quantity: 1, note: "x" }), (e) => e.code === "invalid_items");
  await assert.rejects(() => stock.setKit({ identity, itemId: id.MESA, components: [{ sku: "SOFA-1", quantity: 1 }] }), (e) => e.code === "nested_kit");

  // Regras: conta Magalu com 50%, exceção no anúncio S-MESA fixo 1; conta ML desligada.
  await stock.saveRule({ identity, scope: "account", targetId: mg, rule: { mode: "percent", value: 50 } });
  await stock.saveRule({ identity, scope: "account", targetId: mg, rule: { mode: "percent", value: 50, safetyReserve: 0 } });
  const sMesa = Number((await db.queryOne("select id from hub.listings where listing_id = 'S-MESA'")).id);
  await stock.saveRule({ identity, scope: "listing", targetId: sMesa, rule: { mode: "fixed", value: 1 } });
  await stock.setAccountMode({ identity, accountId: ml, mode: "off" });
  const plan = await stock.plan(T, {});
  const rows = Object.fromEntries(plan.rows.map((r) => [r.listingId, r]));
  assert.deepEqual([rows["S-SOFA"].state, rows["S-SOFA"].desired], ["decrease", 2], "50% de 4 = 2; canal tem 4");
  assert.deepEqual([rows["S-MESA"].state, rows["S-MESA"].desired, rows["S-MESA"].ruleSource], ["decrease", 1, "listing"]);
  assert.equal(rows.MLB1.state, "account_off");
  assert.equal(rows.MLB3.state, "fulfillment");
  assert.equal((await stock.plan(T, { onlyChanges: true })).total, 2);
  assert.equal((await stock.plan(T, { accountId: mg })).total, 2);

  // Remover exceção e pausar sincronização do anúncio.
  await stock.saveRule({ identity, scope: "listing", targetId: sMesa, rule: null });
  await stock.setListingSync({ identity, listingId: sMesa, enabled: false });
  const after = Object.fromEntries((await stock.plan(T, {})).rows.map((r) => [r.listingId, r]));
  assert.equal(after["S-MESA"].state, "sync_off");
  await assert.rejects(() => stock.saveRule({ identity: { tenantId: "outro" }, scope: "listing", targetId: sMesa, rule: null }), (e) => e.status === 404, "outra empresa não mexe");

  const movements = await stock.listMovements(T, { itemId: id["SOFA-1"] });
  assert.equal(movements[0].kind, "initial");
  const csv = await stock.exportCsv(T);
  assert.match(csv, /^﻿sku;nome;tipo;fisico;reservado;disponivel\r\n/);
  assert.match(csv, /KIT-SALA;Kit sala;kit;;;2/);
});

test("planilha aplicada no banco: definir e somar (sem duplicar o mesmo arquivo)", opts, async () => {
  const { id } = await seed();
  const stock = createStockService({ repository: createStockRepository(db) });
  const identity = { tenantId: T, userId: "u1" };
  const file = (text) => ({ fileName: "e.csv", contentBase64: Buffer.from(text).toString("base64") });
  await stock.applySpreadsheet({ identity, file: file("sku;quantidade\nSOFA-1;10\nMESA;3\n"), mode: "set" });
  const entrada = file("sku;quantidade\nSOFA-1;5\n");
  await stock.applySpreadsheet({ identity, file: entrada, mode: "add" });
  const again = await stock.applySpreadsheet({ identity, file: entrada, mode: "add" });
  assert.equal(again.duplicates, 1);
  const bal = Object.fromEntries((await db.query("select item_id, on_hand::float from hub.stock_balances")).rows.map((r) => [Number(r.item_id), r.on_hand]));
  assert.deepEqual([bal[id["SOFA-1"]], bal[id.MESA]], [15, 3]);
});
