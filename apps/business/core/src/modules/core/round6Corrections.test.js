"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", "..", "..", relativePath), "utf8");
}

test("optical workflow emits one canonical event per synchronized stage transition", () => {
  const opticalService = source("src/extensions/optical/backend/opticalService.js");
  const saleHooks = source("src/extensions/optical/backend/saleHooks.js");
  assert.doesNotMatch(opticalService, /insertWorkflowEventWithClient\(client, companyId, "optical_order", "service_order"/);
  assert.doesNotMatch(saleHooks, /"optical_order",\s*"service_order",[\s\S]{0,220}source: "sale_(?:cancel|delivery)"/);
  assert.match(opticalService, /insertWorkflowEventWithClient\(client, companyId, "optical_order", "optical_order"/);
});

test("order history hides legacy mirrored optical workflow events already stored", () => {
  const history = source("src/modules/core/runtime/services/saleHistoryService.js");
  assert.match(history, /function isMirroredOpticalWorkflowEvent/);
  assert.match(history, /row\.workflowKey !== "optical_order" \|\| row\.entityType !== "service_order"/);
  assert.match(history, /if \(isMirroredOpticalWorkflowEvent\(row\)\) continue/);
});

test("delivery settlement shows installment preview, editable installment rows and live redistribution", () => {
  const main = source("src/client/main.jsx");
  assert.match(main, /Previa das parcelas/);
  assert.match(main, /Redistribuir automaticamente/);
  assert.match(main, /updateInstallment/);
  assert.match(main, /redistributePayment/);
  assert.match(main, /deliveryScheduleDifference/);
  assert.match(main, /installmentSchedule/);
  assert.match(main, /splitDeliveryInstallments\(payment\.amount, payment\.installments\)/);
  assert.match(main, /Revise as parcelas: a soma das parcelas precisa ser igual ao saldo financiado/);
  assert.match(main, /disabled=\{saving \|\| scheduleMismatch \|\| paymentMismatch\}/);
});

test("delivery settlement keeps the approved compact financial condition summary visible", () => {
  const main = source("src/client/main.jsx");
  for (const label of ["Total", "Entrada recebida", "Saldo financiado", "Quantidade de parcelas", "Total em aberto"]) {
    assert.match(main, new RegExp(`>${label}<`));
  }
  assert.match(main, /delivery-financial-summary/);
});

test("backend validates custom installment amounts and dates before creating receivables", () => {
  const sales = source("src/modules/core/runtime/services/salesService.js");
  assert.match(sales, /function normalizeInstallmentSchedule/);
  assert.match(sales, /PAYMENT_INSTALLMENT_COUNT_MISMATCH/);
  assert.match(sales, /PAYMENT_INSTALLMENT_AMOUNT_INVALID/);
  assert.match(sales, /PAYMENT_INSTALLMENT_DUE_DATE_INVALID/);
  assert.match(sales, /PAYMENT_INSTALLMENT_TOTAL_MISMATCH/);
  assert.match(sales, /const installmentSchedule = payment\.installmentSchedule\?\.length/);
  assert.match(sales, /dueDate, installment\.amount/);
});

test("customer purchase count uses correct singular and plural text", () => {
  const main = source("src/client/main.jsx");
  assert.match(main, /\? "compra registrada" : "compras registradas"/);
  assert.doesNotMatch(main, /compra\$\{[^}]+\} registradas/);
});

test("installment engine distributes cents deterministically and preserves custom schedules", () => {
  const { __test } = require("./runtime/services/salesService");
  const automatic = __test.normalizeSalePayments([
    { method: "boleto", amount: 100, installments: 3, dueDate: "2026-10-10" },
  ], 100, "2026-09-09T12:00:00Z")[0];
  assert.deepEqual(automatic.installmentSchedule.map((item) => item.amount), [33.34, 33.33, 33.33]);
  assert.deepEqual(automatic.installmentSchedule.map((item) => item.dueDate), ["2026-10-10", "2026-11-10", "2026-12-10"]);

  const custom = __test.normalizeSalePayments([
    {
      method: "store_credit",
      amount: 100,
      installments: 3,
      dueDate: "2026-10-10",
      installmentSchedule: [
        { amount: 40, dueDate: "2026-10-15" },
        { amount: 30, dueDate: "2026-11-20" },
        { amount: 30, dueDate: "2027-01-05" },
      ],
    },
  ], 100, "2026-09-09T12:00:00Z")[0];
  assert.deepEqual(custom.installmentSchedule, [
    { amount: 40, dueDate: "2026-10-15" },
    { amount: 30, dueDate: "2026-11-20" },
    { amount: 30, dueDate: "2027-01-05" },
  ]);
});

test("installment engine rejects schedules whose sum differs from the financed amount", () => {
  const { __test } = require("./runtime/services/salesService");
  assert.throws(() => __test.normalizeSalePayments([
    {
      method: "boleto",
      amount: 100,
      installments: 3,
      dueDate: "2026-10-10",
      installmentSchedule: [
        { amount: 40, dueDate: "2026-10-10" },
        { amount: 30, dueDate: "2026-11-10" },
        { amount: 20, dueDate: "2026-12-10" },
      ],
    },
  ], 100, "2026-09-09T12:00:00Z"), (error) => error?.code === "PAYMENT_INSTALLMENT_TOTAL_MISMATCH");
});

test("canceled orders never render payment as completed in the orders financial column", () => {
  const main = source("src/client/main.jsx");
  const start = main.indexOf("function saleFinancialSummary(sale, receivables)");
  const end = main.indexOf("function saleFinancialStatus", start);
  const financialSummary = main.slice(start, end);
  assert.match(financialSummary, /sale\.statusKey === "canceled"/);
  assert.match(financialSummary, /label: "Cancelado"/);
  assert.ok(
    financialSummary.indexOf('sale.statusKey === "canceled"') < financialSummary.indexOf('return { label: "Pagamento concluido"'),
    "cancelamento deve ter precedencia sobre a inferencia de pagamento concluido",
  );
});

