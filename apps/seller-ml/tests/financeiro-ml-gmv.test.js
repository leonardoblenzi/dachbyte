"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const XLSX = require("xlsx");

process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";

const FinanceiroMlService = require("../services/financeiroMlService");

const {
  resolveRealizedGmv,
  buildMarginExportWorkbook,
  orderLifecycleStatus,
  buildOrderSearchQuery,
  dedupeOrdersById,
  applyPeriodFilters,
  resolveMarginPeriodScope,
} = FinanceiroMlService._test;

test("normalizes Mercado Livre order lifecycle statuses for the period table", () => {
  assert.equal(orderLifecycleStatus({ status: "cancelled" }), "Cancelado");
  assert.equal(orderLifecycleStatus({ shipping: { status: "delivered" } }), "Concluído");
  assert.equal(orderLifecycleStatus({ shipping: { status: "out_for_delivery" } }), "A caminho");
  assert.equal(orderLifecycleStatus({ status: "paid", shipping: { status: "ready_to_ship" } }), "Preparando");
  assert.equal(orderLifecycleStatus({ tags: ["has_return"] }), "Devolução");
  assert.equal(orderLifecycleStatus({ payments: [{ status: "refunded" }] }), "Devolvido");
  assert.equal(orderLifecycleStatus({ tags: ["claim_opened"] }), "Problema");
  assert.equal(
    orderLifecycleStatus({ status: "paid", shipping: { id: 77 } }, { status: "delivered" }),
    "Concluído",
  );
  assert.equal(
    orderLifecycleStatus({ status: "paid", shipping: { id: 78 } }, { status: "not_delivered", substatus: "lost" }),
    "Problema",
  );
});

test("builds an all-orders period query by creation date without a paid status restriction", () => {
  const query = buildOrderSearchQuery(
    123,
    { date_from: "2026-09-01", date_to: "2026-09-02" },
    50,
    0,
    "created",
  );

  assert.equal(query.seller, 123);
  assert.equal(query["order.status"], undefined);
  assert.match(query["order.date_created.from"], /^2026-09-01T00:00:00\.000-03:00$/);
  assert.match(query["order.date_created.to"], /^2026-09-02T23:59:59\.999-03:00$/);
});

test("deduplicates all-orders pages using the most recently updated order", () => {
  const rows = dedupeOrdersById([
    { id: 10, last_updated: "2026-09-01T10:00:00.000-03:00", status: "paid" },
    { id: 10, last_updated: "2026-09-01T12:00:00.000-03:00", status: "cancelled" },
    { id: 11, last_updated: "2026-09-01T11:00:00.000-03:00", status: "paid" },
  ]);

  assert.deepEqual(rows.map((row) => [row.id, row.status]), [
    [10, "cancelled"],
    [11, "paid"],
  ]);
});

test("filters only period rows by the normalized order status", () => {
  const rows = [
    { order_id: "1", lifecycle_status: "Preparando", profit: 5, margin_pct: 10, has_cost: true },
    { order_id: "2", lifecycle_status: "A caminho", profit: 5, margin_pct: 10, has_cost: true },
    { order_id: "3", lifecycle_status: "Concluído", profit: 5, margin_pct: 10, has_cost: true },
  ];

  assert.deepEqual(
    applyPeriodFilters(rows, { order_status: "in_progress" }).map((row) => row.order_id),
    ["1", "2"],
  );
  assert.deepEqual(
    applyPeriodFilters(rows, { order_status: "completed" }).map((row) => row.order_id),
    ["3"],
  );
});

test("keeps the paid financial summary separate from all-order period rows", () => {
  const paidSummary = { period_revenue: 100, profit: 25 };
  const scope = resolveMarginPeriodScope({
    paidFinancials: {
      summary: paidSummary,
      orders: [{ order_id: "paid", lifecycle_status: "Concluído", profit: 25, margin_pct: 25, has_cost: true }],
    },
    allOrderFinancials: {
      orders: [
        { order_id: "paid", lifecycle_status: "Concluído", profit: 25, margin_pct: 25, has_cost: true },
        { order_id: "cancelled", lifecycle_status: "Cancelado", profit: 0, margin_pct: 0, has_cost: true },
      ],
    },
    query: { order_status: "cancelled" },
  });

  assert.strictEqual(scope.summary, paidSummary);
  assert.deepEqual(scope.summaryRows.map((row) => row.order_id), ["paid"]);
  assert.deepEqual(scope.periodRows.map((row) => row.order_id), ["cancelled"]);
});

test("uses gross order total plus buyer shipping as GMV", () => {
  const result = resolveRealizedGmv({
    orderProductTotal: 734.44,
    fullOrderRevenue: 734.44,
    revenueBase: 734.44,
    buyerShippingFull: 96.71,
    selectionRatio: 1,
    totalCosts: 617.04,
  });

  assert.equal(result.gmv, 831.15);
  assert.equal(result.source, "order.total_amount+buyer_shipping");
  assert.equal(result.profit, 214.11);
  assert.equal(Number(result.marginPct.toFixed(2)), 25.76);
});

test("does not subtract commissions or coupon while building GMV", () => {
  const result = resolveRealizedGmv({
    orderProductTotal: 1144.08,
    fullOrderRevenue: 1144.08,
    revenueBase: 1144.08,
    buyerShippingFull: 935.27,
    selectionRatio: 1,
    totalCosts: 1026.14,
  });

  assert.equal(result.gmv, 2079.35);
  assert.equal(result.profit, 1053.21);
});

test("exports gross GMV and only STATUS as the added period column", () => {
  const workbook = buildMarginExportWorkbook({
    period_rows: [{
      order_id: "2000018284539198",
      gmv: 831.15,
      product_revenue: 734.44,
      product_cost: 435.88,
      commissions: 73.04,
      buyer_shipping_paid: 96.71,
      tax_base: 831.15,
      taxes: 83.12,
      coupon_discount: 25,
      rebate: 22.72,
      total_costs: 617.04,
      profit: 214.11,
      margin_pct: 25.76,
      lifecycle_status: "Preparando",
    }],
  });
  const sheet = workbook.Sheets["Margem por periodo"];
  const [headers, row] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  assert.equal(headers.includes("FONTE_GMV"), false);
  assert.equal(headers.includes("IDS_PAGAMENTO"), false);
  assert.equal(headers.at(-1), "STATUS");
  assert.equal(row[headers.indexOf("GMV")], 831.15);
  assert.equal(row[headers.indexOf("RESULTADO")], 214.11);
  assert.equal(row.at(-1), "Preparando");
});
