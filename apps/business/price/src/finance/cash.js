"use strict";

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function dateOnly(value) {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addMonths(date, months) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function generateInstallments({ amount, installments = 1, firstDueDate }) {
  const count = Math.max(1, Math.min(360, Math.trunc(Number(installments) || 1)));
  const cents = Math.round(money(amount) * 100);
  if (cents <= 0) throw new Error("Valor deve ser maior que zero.");
  const base = Math.floor(cents / count);
  let remainder = cents - base * count;
  const first = dateOnly(firstDueDate);
  if (!first) throw new Error("Data do primeiro vencimento invalida.");
  return Array.from({ length: count }, (_, index) => {
    const part = base + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    return { number: index + 1, total: count, amount: part / 100, dueDate: addMonths(first, index).toISOString().slice(0, 10) };
  });
}

function nextRecurrenceDate(value, frequency, intervalCount = 1) {
  const date = dateOnly(value);
  if (!date) throw new Error("Data de recorrencia invalida.");
  const interval = Math.max(1, Math.trunc(Number(intervalCount) || 1));
  if (frequency === "weekly") date.setUTCDate(date.getUTCDate() + 7 * interval);
  else if (frequency === "yearly") date.setUTCFullYear(date.getUTCFullYear() + interval);
  else return addMonths(date, interval).toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function signed(entry, value) {
  return (entry.direction === "inflow" ? 1 : -1) * money(value);
}

function projectCash({ openingBalance = 0, entries = [], today = new Date() }) {
  const start = dateOnly(today.toISOString().slice(0, 10));
  const currentBalance = money(openingBalance + entries.reduce((sum, entry) => sum + signed(entry, entry.realized_amount), 0));
  const pending = entries.filter((entry) => !["paid", "cancelled"].includes(entry.status) && money(entry.amount) > money(entry.realized_amount));
  const committed = money(pending.filter((entry) => entry.direction === "outflow").reduce((sum, entry) => sum + money(entry.amount) - money(entry.realized_amount), 0));
  const receivable = money(pending.filter((entry) => entry.direction === "inflow").reduce((sum, entry) => sum + money(entry.amount) - money(entry.realized_amount), 0));
  const overdue = pending.filter((entry) => {
    const expected = dateOnly(entry.expected_date || entry.due_date);
    return expected && expected < start;
  });
  const horizons = [7, 15, 30, 60, 90];
  const scenarioFactors = {
    conservative: { inflow: 0.8, outflow: 1.05 },
    base: { inflow: 1, outflow: 1 },
    expansion: { inflow: 1.1, outflow: 1.05 },
  };
  const scenarios = {};
  for (const [scenario, factor] of Object.entries(scenarioFactors)) {
    scenarios[scenario] = horizons.map((days) => {
      const limit = new Date(start); limit.setUTCDate(limit.getUTCDate() + days);
      const projected = pending.filter((entry) => {
        const expected = dateOnly(entry.expected_date || entry.due_date);
        return expected && expected <= limit;
      }).reduce((sum, entry) => {
        const remaining = money(entry.amount) - money(entry.realized_amount);
        return sum + signed(entry, remaining * factor[entry.direction]);
      }, currentBalance);
      return { days, balance: money(projected) };
    });
  }
  return {
    currentBalance,
    committed,
    receivable,
    freeCash: money(currentBalance - committed),
    overdueCount: overdue.length,
    overdueAmount: money(overdue.reduce((sum, entry) => sum + (money(entry.amount) - money(entry.realized_amount)), 0)),
    scenarios,
  };
}

function dreByCompetence(entries = []) {
  const periods = new Map();
  for (const entry of entries) {
    if (entry.status === "cancelled") continue;
    const date = String(entry.competence_date || entry.expected_date || entry.due_date || "").slice(0, 7);
    if (!date) continue;
    const row = periods.get(date) || { period: date, revenue: 0, expenses: 0, result: 0 };
    if (entry.direction === "inflow") row.revenue = money(row.revenue + money(entry.amount));
    else row.expenses = money(row.expenses + money(entry.amount));
    row.result = money(row.revenue - row.expenses);
    periods.set(date, row);
  }
  return [...periods.values()].sort((a, b) => b.period.localeCompare(a.period));
}

module.exports = { money, generateInstallments, nextRecurrenceDate, projectCash, dreByCompetence };
