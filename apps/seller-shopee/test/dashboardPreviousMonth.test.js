"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const DashboardController = require("../src/controllers/DashboardController");

test("fecha fevereiro bissexto inteiro no fuso do relatorio", () => {
  const range = DashboardController._test?.buildPreviousClosedMonthRange?.(
    new Date("2024-03-15T12:00:00.000Z"),
    "-03:00",
  );

  assert.deepEqual(range, {
    label: "2024-02",
    dateFrom: "2024-02-01",
    dateTo: "2024-02-29",
    start: new Date("2024-02-01T03:00:00.000Z"),
    end: new Date("2024-03-01T02:59:59.999Z"),
  });
});

test("resume faturamento, pedidos e ticket do mes anterior fechado", () => {
  assert.equal(typeof DashboardController._test.buildPreviousClosedMonthSummary, "function");
  const summary = DashboardController._test.buildPreviousClosedMonthSummary(
    {
      label: "2026-08",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
      start: new Date("2026-08-01T03:00:00.000Z"),
      end: new Date("2026-09-01T02:59:59.999Z"),
    },
    { total: 123456, count: 3 },
  );

  assert.deepEqual(summary, {
    period: { label: "2026-08", dateFrom: "2026-08-01", dateTo: "2026-08-31" },
    gmvPreviousMonthCents: 123456,
    paidOrdersPreviousMonth: 3,
    avgTicketPreviousMonthCents: 41152,
  });
});

test("fecha dezembro corretamente na virada do ano", () => {
  const range = DashboardController._test.buildPreviousClosedMonthRange(
    new Date("2027-01-10T12:00:00.000Z"),
    "-03:00",
  );

  assert.equal(range.label, "2026-12");
  assert.equal(range.dateFrom, "2026-12-01");
  assert.equal(range.dateTo, "2026-12-31");
  assert.equal(range.start.toISOString(), "2026-12-01T03:00:00.000Z");
  assert.equal(range.end.toISOString(), "2027-01-01T02:59:59.999Z");
});

test("respeita meses fechados de 28 e 30 dias", () => {
  const february = DashboardController._test.buildPreviousClosedMonthRange(
    new Date("2025-03-10T12:00:00.000Z"),
    "-03:00",
  );
  const april = DashboardController._test.buildPreviousClosedMonthRange(
    new Date("2026-05-10T12:00:00.000Z"),
    "-03:00",
  );

  assert.equal(february.dateTo, "2025-02-28");
  assert.equal(april.dateTo, "2026-04-30");
});
