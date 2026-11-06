"use strict";

// Fase 3 / P1: situação padronizada e campos do pedido nos três canais; mês da cobrança.
const test = require("node:test");
const assert = require("node:assert/strict");
const { mapOrder: mlOrder, mlStage } = require("../src/connectors/mercadolivre/orders");
const { mapOrder: magaluOrder } = require("../src/connectors/magalu/orders");
const { mapOrder: shopeeOrder } = require("../src/connectors/shopee/orders");
const { stageOf } = require("../src/modules/orders/repository");
const { monthInSaoPaulo, monthStart } = require("../src/modules/billing/service");
const { MercadoLivreConnector } = require("../src/connectors/mercadolivre/MercadoLivreConnector");

test("ML: situação pelo pedido + envio; devolução continua venda no estoque", () => {
  assert.equal(mlStage("payment_required", null, {}), "new");
  assert.equal(mlStage("paid", { status: "pending" }, {}), "paid");
  assert.equal(mlStage("paid", { status: "ready_to_ship" }, {}), "ready_to_ship");
  assert.equal(mlStage("paid", { status: "in_transit" }, {}), "shipped");
  assert.equal(mlStage("paid", { status: "delivered" }, {}), "delivered");
  assert.equal(mlStage("cancelled", { status: "cancelled" }, {}), "cancelled");
  assert.equal(mlStage("paid", { status: "delivered", tags: ["has_return"] }, {}), "returned");
  const o = mlOrder(
    { id: 9, status: "paid", total_amount: 300, paid_amount: 325.5, buyer: { first_name: "Ana", last_name: "Lima" }, shipping: { id: 77 },
      order_items: [{ item: { id: "MLB1", variation_id: 5 }, quantity: 2, unit_price: 150, sale_fee: 22.5 }] },
    { status: "ready_to_ship", logistic: { type: "xd_drop_off" }, tracking_number: "BR123", lead_time: { estimated_handling_limit: { date: "2026-11-07T23:59:00-03:00" } } },
    { expected_date: "2026-11-07T18:00:00-03:00" });
  assert.deepEqual([o.stage, o.status, o.productsTotal, o.shippingPaid, o.shipBy, o.trackingCode, o.logisticType, o.buyer.name, o.lines[0].saleFee],
    ["ready_to_ship", "open", 300, 25.5, "2026-11-07T18:00:00-03:00", "BR123", "xd_drop_off", "Ana Lima", 45]);
});

test("ML: pedido busca o envio e o SLA só enquanto não foi enviado", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url)); calls.push([u.pathname, init.headers?.["x-format-new"]]);
    const body = u.pathname === "/orders/1" ? { id: 1, status: "paid", shipping: { id: 50 }, order_items: [] }
      : u.pathname === "/shipments/50" ? { status: "shipped", status_history: { date_shipped: "2026-11-06T10:00:00Z" } } : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const ml = new MercadoLivreConnector({ clientId: "1", clientSecret: "s", fetchImpl });
  const order = await ml.getOrder({ accessToken: "T" }, "1");
  assert.equal(order.stage, "shipped");
  assert.equal(order.shippedAt, "2026-11-06T10:00:00Z");
  assert.deepEqual(calls, [["/orders/1", undefined], ["/shipments/50", "true"]], "enviado: não busca SLA");
});

test("Magalu e Shopee: situação, prazo, rastreio, frete; Shopee descarta endereço mascarado", () => {
  const mg = magaluOrder({ code: "LU-1", status: "approved", amounts: { total: { value: 21990, normalizer: 100 } },
    deliveries: [{ id: 3, status: "invoiced", handling_time: { limit_date: "2026-11-08T12:00:00Z" }, amounts: { freight: { total: { value: 2000, normalizer: 100 } } },
      shipping: { provider: { name: "Magalu Entregas" }, tracking: { code: "MG1" } }, items: [{ sku: "A", quantity: 1, unit_price: { value: 19990, normalizer: 100 } }] }] });
  assert.deepEqual([mg.stage, mg.shipBy, mg.carrier, mg.trackingCode, mg.shippingPaid, mg.channelStatus], ["invoiced", "2026-11-08T12:00:00Z", "Magalu Entregas", "MG1", 20, "approved / invoiced"]);
  assert.equal(magaluOrder({ code: "X", status: "cancelled", deliveries: [] }).stage, "cancelled");

  const sp = shopeeOrder({ order_sn: "S1", order_status: "PROCESSED", total_amount: 120, ship_by_date: 1_790_000_000, shipping_carrier: "Shopee Xpress",
    package_list: [{ package_number: "P1", tracking_number: "-" }], recipient_address: { city: "São Paulo", state: "S***o" },
    item_list: [{ item_id: 1, model_id: 0, model_quantity_purchased: 2, model_discounted_price: 50 }] });
  assert.deepEqual([sp.stage, sp.productsTotal, sp.shippingPaid, sp.trackingCode, sp.buyer.city, sp.buyer.state], ["ready_to_ship", 100, 20, null, "São Paulo", null]);
  assert.deepEqual([shopeeOrder({ order_sn: "S2", order_status: "TO_RETURN" }).stage, shopeeOrder({ order_sn: "S2", order_status: "TO_RETURN" }).status], ["returned", "open"]);
  assert.equal(shopeeOrder({ order_sn: "S3", order_status: "UNPAID" }).stage, "new");
});

test("situação padrão e mês no fuso de São Paulo", () => {
  assert.equal(stageOf({ status: "cancelled", lines: [] }), "cancelled");
  assert.equal(stageOf({ status: "open", lines: [] }), "paid");
  assert.equal(stageOf({ status: "open", stage: "xpto", lines: [] }), "paid");
  assert.equal(monthInSaoPaulo(new Date("2026-12-01T02:30:00Z")), "2026-11", "23:30 de 30/11 em São Paulo ainda é novembro");
  assert.equal(monthStart("2026-02"), "2026-02-01");
  assert.throws(() => monthStart("2026-13"), (e) => e.code === "invalid_month");
});
