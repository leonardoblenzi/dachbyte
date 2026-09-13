"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { generateInstallments, nextRecurrenceDate, projectCash, dreByCompetence } = require("../src/finance/cash");

test("parcelamento preserva centavos e datas mensais", () => {
  const installments = generateInstallments({ amount: 100, installments: 3, firstDueDate: "2026-01-31" });
  assert.deepEqual(installments.map((item) => item.amount), [33.34, 33.33, 33.33]);
  assert.deepEqual(installments.map((item) => item.dueDate), ["2026-01-31", "2026-02-28", "2026-03-31"]);
  assert.equal(installments.reduce((sum, item) => sum + item.amount, 0), 100);
});

test("recorrencia respeita fim de mes", () => {
  assert.equal(nextRecurrenceDate("2026-01-31", "monthly", 1), "2026-02-28");
  assert.equal(nextRecurrenceDate("2026-02-01", "weekly", 2), "2026-02-15");
});

test("projecao separa caixa atual, comprometido, livre e cenarios", () => {
  const entries = [
    { direction: "inflow", amount: 200, realized_amount: 200, status: "paid", expected_date: "2026-08-01" },
    { direction: "outflow", amount: 100, realized_amount: 100, status: "paid", expected_date: "2026-08-01" },
    { direction: "outflow", amount: 300, realized_amount: 0, status: "open", expected_date: "2026-08-15" },
    { direction: "inflow", amount: 500, realized_amount: 0, status: "open", expected_date: "2026-08-20" },
  ];
  const result = projectCash({ openingBalance: 1000, entries, today: new Date("2026-08-10T12:00:00Z") });
  assert.equal(result.currentBalance, 1100);
  assert.equal(result.committed, 300);
  assert.equal(result.receivable, 500);
  assert.equal(result.freeCash, 800);
  assert.equal(result.scenarios.base.find((item) => item.days === 7).balance, 800);
  assert.equal(result.scenarios.base.find((item) => item.days === 15).balance, 1300);
  assert.equal(result.scenarios.conservative.find((item) => item.days === 15).balance, 1185);
});

test("DRE usa competencia e nao data de pagamento", () => {
  const result = dreByCompetence([
    { direction: "inflow", amount: 1000, competence_date: "2026-07-31", realized_date: "2026-08-10", status: "paid" },
    { direction: "outflow", amount: 400, competence_date: "2026-07-15", realized_date: "2026-08-01", status: "paid" },
    { direction: "outflow", amount: 50, competence_date: "2026-08-01", status: "open" },
  ]);
  assert.deepEqual(result, [
    { period: "2026-08", revenue: 0, expenses: 50, result: -50 },
    { period: "2026-07", revenue: 1000, expenses: 400, result: 600 },
  ]);
});
