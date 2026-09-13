"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeTrayOrder, syncWindow } = require("../src/orders/normalization");
const { safeError } = require("../src/orders/traySync");
const { unlinkMarketplaceOrder } = require("../src/routes/orders.routes");

test("pedido Tray ML preserva seller explicito", () => {
  const result = normalizeTrayOrder({ Order: {
    id: "42", MarketplaceOrder: [{ marketplace: "Mercado Livre", platform_order_id: "2001", seller_id: "987" }],
  } });
  assert.equal(result.marketplace, "meli");
  assert.equal(result.marketplaceAccountId, "987");
  assert.equal(result.marketplaceAccountSource, "tray_explicit");
});

test("pedido ML sem seller nao recebe conta padrao", () => {
  const result = normalizeTrayOrder({ Order: { id: "43", MlOrder: [{ order_id: "2002" }] } });
  assert.equal(result.marketplace, "meli");
  assert.equal(result.marketplaceAccountId, null);
  assert.equal(result.marketplaceAccountSource, null);
});

test("unlink limpa a conta de marketplace vinculada manualmente", async () => {
  const queries = [];
  const client = {
    query: async (query, values) => {
      queries.push({ query, values });
      return { rows: [{ id: "42", reconciliation_status: "unmatched", marketplace_account_id: null, marketplace_account_source: null }] };
    },
  };

  const result = await unlinkMarketplaceOrder(client, "42");

  assert.deepEqual(result, {
    id: "42",
    reconciliation_status: "unmatched",
    marketplace_account_id: null,
    marketplace_account_source: null,
  });
  assert.match(queries[0].query, /marketplace_account_id=NULL/);
  assert.match(queries[0].query, /marketplace_account_source=NULL/);
  assert.deepEqual(queries[0].values, ["42"]);
});

test("normaliza pedido Tray e aceita somente identificador explicito como match automatico", () => {
  const order = normalizeTrayOrder({ Order: {
    id: 42,
    status: "A ENVIAR",
    date: "2026-08-01",
    modified: "2026-08-10 09:30:00",
    total: "159.90",
    MarketplaceOrder: [{ marketplace: "Mercado Livre", platform_order_id: "20000000001" }],
  } });
  assert.equal(order.sourceOrderId, "42");
  assert.equal(order.totalAmount, 159.9);
  assert.equal(order.marketplace, "meli");
  assert.equal(order.marketplaceOrderId, "20000000001");
  assert.equal(order.reconciliationStatus, "matched");
  assert.equal(order.matchConfidence, 1);
});

test("referencia fraca vai para revisao humana e nunca e conciliada automaticamente", () => {
  const order = normalizeTrayOrder({ id: "43", point_sale: "canal externo", external_code: "ABC-9" });
  assert.equal(order.marketplace, null);
  assert.equal(order.marketplaceOrderId, null);
  assert.equal(order.reconciliationStatus, "review");
  assert.equal(order.matchReason, "weak_reference_requires_review");
});

test("sync incremental usa checkpoint com sobreposicao de um dia", () => {
  const window = syncWindow({
    checkpoint: { cursor: { maxModifiedAt: "2026-08-09T15:00:00Z" } },
    now: new Date("2026-08-10T12:00:00Z"),
  });
  assert.deepEqual(window, { from: "2026-08-08", to: "2026-08-10", mode: "incremental" });
});

test("primeiro sync sem periodo limita carga historica inicial a 90 dias", () => {
  const window = syncWindow({ now: new Date("2026-08-10T12:00:00Z") });
  assert.deepEqual(window, { from: "2026-05-12", to: "2026-08-10", mode: "historical" });
});

test("erro persistido nao inclui URL potencialmente sensivel", () => {
  assert.equal(safeError(new Error("401 em https://api.example.test/orders?access_token=secret")), "401 em [URL]");
});
