"use strict";

// Automações contra Postgres de verdade (HUB_TEST_DATABASE_URL), sem fila (executa na hora) e com webhook falso.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createDb } = require("../src/platform/db");
const { createCatalogRepository } = require("../src/modules/catalog/repository");
const { createCatalogService } = require("../src/modules/catalog/service");
const { createAccountsRepository } = require("../src/modules/accounts/repository");
const { createStockRepository } = require("../src/modules/stock/repository");
const { createOrdersRepository } = require("../src/modules/orders/repository");
const { createOrdersService } = require("../src/modules/orders/service");
const { createAutomationsRepository } = require("../src/modules/automations/repository");
const { createAutomationsService } = require("../src/modules/automations/service");

const url = process.env.HUB_TEST_DATABASE_URL || "";
const opts = { skip: url ? false : "defina HUB_TEST_DATABASE_URL para rodar" };
const db = url ? createDb({ databaseUrl: url, schema: "hub" }) : null;
const T = "tenant-auto";
const identity = { tenantId: T, userId: "admin" };

async function setup() {
  await db.query("truncate hub.items, hub.channel_accounts, hub.locations, hub.audit_events, hub.tenant_settings, hub.webhook_events, hub.order_statuses, hub.automation_rules, hub.notifications restart identity cascade");
  const ml = Number((await createAccountsRepository(db).upsertAccount({ tenantId: T, channel: "mercadolivre", externalAccountId: "55", label: "Loja ML", userId: "u" })).id);
  await createCatalogService({ repository: createCatalogRepository(db) }).applyListings({ tenantId: T, accountId: ml, listings: [{ listingId: "MLB1", channelSku: "SOFA-1", stock: 5 }] });
  const hooks = [];
  let hookStatus = 200;
  const fetchImpl = async (u, init) => { hooks.push({ url: u, init }); return { ok: hookStatus < 400, status: hookStatus }; };
  const automations = createAutomationsService({ repository: createAutomationsRepository(db), fetchImpl });
  const orders = createOrdersService({ repository: createOrdersRepository(db), stockRepository: createStockRepository(db), onOrderChanged: (c) => automations.orderChanged(c) });
  const account = { id: ml, tenantId: T };
  const ingest = (o) => orders.ingest(account, { status: "open", orderedAt: new Date().toISOString(), lines: [{ lineKey: "MLB1:", listingId: "MLB1", quantity: 1, unitPrice: 1200 }], ...o });
  const orderRow = async (orderId) => db.queryOne(
    "select o.id, o.tags, s.name as status from hub.channel_orders o left join hub.order_statuses s on s.id = o.custom_status_id where o.external_order_id = $1", [orderId]);
  return { automations, orders, ingest, orderRow, hooks, setHookStatus: (s) => { hookStatus = s; } };
}

test.after(async () => { if (db) await db.close(); });

test("pedido recebido dispara regra; status interno encadeia outra; reprocessar não repete", opts, async () => {
  const { automations, ingest, orderRow } = await setup();
  const separar = await automations.saveStatus({ identity, name: "Separar", color: "blue" });
  const urgente = await automations.saveStatus({ identity, name: "Urgente", color: "red" });
  await assert.rejects(() => automations.saveStatus({ identity, name: "separar", color: "blue" }), (e) => e.code === "status_conflict");
  await automations.saveRule({ identity, input: { name: "Pago vai para separação", event: "stage_changed", eventParams: { stage: "paid" },
    conditions: [{ field: "productsTotal", op: "gte", value: 1000 }], actions: [{ type: "set_custom_status", statusId: separar.id }, { type: "add_tag", tag: "Alto valor" }] } });
  await automations.saveRule({ identity, input: { name: "Separar avisa", event: "custom_status_changed",
    conditions: [{ field: "customStatusId", op: "is", value: separar.id }], actions: [{ type: "notify", title: "Separar pedido de alto valor" }] } });
  await assert.rejects(() => automations.saveRule({ identity, input: { name: "x", event: "order_received", actions: [{ type: "set_custom_status", statusId: 999 }] } }), /não existe/);

  await ingest({ orderId: "A1", stage: "paid" });
  let row = await orderRow("A1");
  assert.deepEqual([row.status, row.tags], ["Separar", ["Alto valor"]]);
  assert.equal(await automations.unreadCount(T), 1, "a regra encadeada avisou a equipe");
  await ingest({ orderId: "A1", stage: "paid" });
  assert.equal(await automations.unreadCount(T), 1, "reprocessar o mesmo pedido não repete");
  const events = (await db.query("select kind, note from hub.order_events where order_id = $1 order by id", [row.id])).rows.map((e) => e.kind);
  assert.ok(events.includes("automation") && events.includes("custom_status") && events.includes("tags"), "linha do tempo registra");

  // Pedido abaixo do valor: não bate a condição.
  await ingest({ orderId: "B2", stage: "paid", lines: [{ lineKey: "MLB1:", listingId: "MLB1", quantity: 1, unitPrice: 100 }] });
  row = await orderRow("B2");
  assert.deepEqual([row.status, row.tags], [null, []]);

  // Manual em lote: status e etiquetas; excluir status em uso numa regra é bloqueado.
  const ids = (await db.query("select id from hub.channel_orders order by id")).rows.map((r) => Number(r.id));
  assert.equal((await automations.setStatus({ identity, orderIds: ids, statusId: Number(urgente.id) })).changed, 2);
  assert.equal((await automations.changeTags({ identity, orderIds: ids, add: ["Revisar"], remove: ["alto valor"] })).changed, 2);
  assert.deepEqual((await orderRow("A1")).tags, ["Revisar"]);
  await assert.rejects(() => automations.deleteStatus({ identity, id: Number(separar.id) }), (e) => e.code === "status_in_use");
  assert.ok(await automations.deleteStatus({ identity, id: Number(urgente.id) }));
  assert.equal((await orderRow("A1")).status, null, "pedidos ficam sem status");
});

test("prazo vencendo e vencido pela varredura; manual pelo botão; webhook assinado e falha registrada", opts, async () => {
  const { automations, ingest, orderRow, hooks, setHookStatus } = await setup();
  await automations.saveRule({ identity, input: { name: "Vence em 4h", event: "ship_by_soon", eventParams: { hours: 4 }, actions: [{ type: "add_tag", tag: "Vence hoje" }] } });
  await automations.saveRule({ identity, input: { name: "Atrasado", event: "order_late", actions: [{ type: "add_tag", tag: "Atrasado" }] } });
  await ingest({ orderId: "S1", stage: "paid", shipBy: new Date(Date.now() + 2 * 3600e3).toISOString() });
  await ingest({ orderId: "L1", stage: "ready_to_ship", shipBy: new Date(Date.now() - 3600e3).toISOString() });
  await ingest({ orderId: "X1", stage: "shipped", shipBy: new Date(Date.now() - 3600e3).toISOString() });
  assert.deepEqual(await automations.scanDue(), { fired: 2 });
  await automations.scanDue();
  assert.deepEqual([(await orderRow("S1")).tags, (await orderRow("L1")).tags, (await orderRow("X1")).tags], [["Vence hoje"], ["Atrasado"], []], "já enviado não conta; varrer de novo não repete");

  const manual = await automations.saveRule({ identity, input: { name: "Mandar para o ERP", event: "manual", actions: [{ type: "webhook", url: "https://erp.cliente.com.br/hook" }] } });
  const s1 = Number((await orderRow("S1")).id);
  assert.deepEqual(await automations.runNow({ identity, ruleId: Number(manual.id), orderIds: [s1] }), { ran: 1 });
  const call = hooks[0];
  const secret = await automations.webhookSecret(T);
  assert.equal(call.init.headers["x-dachhub-signature"], `sha256=${crypto.createHmac("sha256", secret).update(call.init.body).digest("hex")}`);
  assert.equal(JSON.parse(call.init.body).order.orderId, "S1");
  assert.deepEqual(await automations.runNow({ identity, ruleId: Number(manual.id), orderIds: [s1] }), { ran: 1 }, "botão manual pode rodar de novo");
  setHookStatus(500);
  await automations.runNow({ identity, ruleId: Number(manual.id), orderIds: [s1] });
  const runs = await automations.listRuns(T, Number(manual.id));
  assert.equal(runs[0].status, "failed");
  assert.match(runs[0].error, /500/);
  await automations.setActive({ identity, id: Number(manual.id), active: false });
  await assert.rejects(() => automations.runNow({ identity, ruleId: Number(manual.id), orderIds: [s1] }), (e) => e.code === "rule_inactive");
  const rules = await automations.listRules(T);
  assert.equal(rules.find((r) => r.name === "Mandar para o ERP").failures7d, 1);
});
