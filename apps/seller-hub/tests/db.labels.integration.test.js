"use strict";

// Etiquetas contra Postgres de verdade (HUB_TEST_DATABASE_URL), com conector falso (sem rede).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("../src/platform/db");
const { createAccountsRepository } = require("../src/modules/accounts/repository");
const { createStockRepository } = require("../src/modules/stock/repository");
const { createOrdersRepository } = require("../src/modules/orders/repository");
const { createOrdersService } = require("../src/modules/orders/service");
const { createLabelsRepository } = require("../src/modules/labels/repository");
const { createLabelsService } = require("../src/modules/labels/service");

const url = process.env.HUB_TEST_DATABASE_URL || "";
const opts = { skip: url ? false : "defina HUB_TEST_DATABASE_URL para rodar" };
const db = url ? createDb({ databaseUrl: url, schema: "hub" }) : null;
const T = "tenant-labels";
const identity = { tenantId: T, userId: "operador" };

test.after(async () => { if (db) await db.close(); });

test("lote de etiquetas: um arquivo por conta, falhas por pedido, rastreio gravado, Full/cancelado/enviado fora", opts, async () => {
  await db.query("truncate hub.items, hub.channel_accounts, hub.locations, hub.audit_events, hub.label_batches restart identity cascade");
  const accounts = createAccountsRepository(db);
  const ml = Number((await accounts.upsertAccount({ tenantId: T, channel: "mercadolivre", externalAccountId: "55", label: "Loja ML", userId: "u" })).id);
  const mg = Number((await accounts.upsertAccount({ tenantId: T, channel: "magalu", externalAccountId: "mg", label: "Loja Magalu", userId: "u" })).id);
  const orders = createOrdersService({ repository: createOrdersRepository(db), stockRepository: createStockRepository(db) });
  const line = [{ lineKey: "a", listingId: "X", quantity: 1 }];
  await orders.ingest({ id: ml, tenantId: T }, { orderId: "M1", status: "open", stage: "ready_to_ship", shipmentId: "100", lines: line });
  await orders.ingest({ id: ml, tenantId: T }, { orderId: "M2", status: "open", stage: "ready_to_ship", shipmentId: "999", lines: line });
  await orders.ingest({ id: ml, tenantId: T }, { orderId: "M3", status: "open", stage: "paid", fulfillment: true, lines: line });
  await orders.ingest({ id: ml, tenantId: T }, { orderId: "M4", status: "cancelled", lines: line });
  await orders.ingest({ id: mg, tenantId: T }, { orderId: "G1", status: "open", stage: "invoiced", channelRefs: { channelId: "ch", deliveryIds: ["d1"] }, lines: line });
  await orders.ingest({ id: mg, tenantId: T }, { orderId: "G2", status: "open", stage: "delivered", lines: line });
  const ids = Object.fromEntries((await db.query("select id, external_order_id from hub.channel_orders")).rows.map((r) => [r.external_order_id, Number(r.id)]));

  const seen = [];
  const connector = (channel) => ({
    async fetchLabels(account, refs, { format }) {
      seen.push({ channel, account: account.id, refs: refs.map((r) => r.orderId), format, refsOf: refs.map((r) => r.refs) });
      return {
        files: [{ contentType: "application/pdf", buffer: Buffer.from(`%PDF ${channel}`), extension: "pdf", orders: refs.length }],
        results: refs.map((r) => (r.orderId === "M2" ? { ref: r.ref, ok: false, error: "not_printable_status" } : { ref: r.ref, ok: true, trackingCode: `TR-${r.orderId}` })),
      };
    },
  });
  const connectors = { has: () => true, definition: () => ({ capabilities: { labels: true } }), get: (c) => connector(c) };
  const labels = createLabelsService({ repository: createLabelsRepository(db), connectors, tokens: { getAccessToken: async () => ({ accessToken: "T", externalAccountId: "x" }) } });

  const batch = await labels.print({ identity, orderIds: Object.values(ids), format: "pdf" });
  assert.deepEqual(seen.map((s) => [s.channel, s.refs]), [["mercadolivre", ["M1", "M2"]], ["magalu", ["G1"]]], "um pedido ao canal por conta; Full, cancelado e entregue ficam fora");
  assert.deepEqual(seen[1].refsOf, [{ channelId: "ch", deliveryIds: ["d1"] }], "referências do canal chegam ao conector");
  assert.equal(batch.files.length, 2);
  assert.deepEqual(batch.files.map((f) => f.channel), ["mercadolivre", "magalu"]);
  assert.match(batch.files[0].filename, /^etiquetas-ml-\d+-\d{12}\.pdf$/);
  const reasons = Object.fromEntries(batch.failures.map((f) => [f.orderId, f.error]));
  assert.deepEqual(Object.keys(reasons).sort(), ["G2", "M2", "M3", "M4"]);
  assert.match(reasons.M3, /Full/);
  assert.equal(reasons.M2, "not_printable_status");
  const m1 = await db.queryOne("select tracking_code, label_prints, label_printed_at from hub.channel_orders where id = $1", [ids.M1]);
  assert.deepEqual([m1.tracking_code, m1.label_prints, Boolean(m1.label_printed_at)], ["TR-M1", 1, true]);
  assert.equal((await db.queryOne("select label_prints from hub.channel_orders where id = $1", [ids.M2])).label_prints, 0);
  const file = await labels.file(T, Number(batch.files[0].id));
  assert.equal(file.content.toString(), "%PDF mercadolivre");
  await assert.rejects(() => labels.file("outra", Number(batch.files[0].id)), (e) => e.status === 404, "arquivo de outra empresa não abre");
  assert.equal((await labels.listBatches(T)).length, 1);
  await db.query("update hub.label_batches set created_at = now() - interval '8 days'");
  assert.equal(await labels.cleanup(), 1);
  assert.equal((await db.queryOne("select count(*)::int as n from hub.label_files")).n, 0, "arquivos antigos apagados");
  await assert.rejects(() => labels.print({ identity, orderIds: [] }), (e) => e.code === "invalid_selection");
});
