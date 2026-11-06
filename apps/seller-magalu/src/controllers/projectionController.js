"use strict";

// Projecao mensal do Magalu (mesmas regras do ML):
// - projecao do mes = (faturamento ate hoje / dia do mes) x dias do mes;
// - comparativos com o mes anterior ate o mesmo dia;
// - medias (ritmo diario e pedidos por dia) so com dias fechados.
// Ajuste Magalu: filtro pelos status do pedido que a API trouxe para a conta.

const accountRepository = require("../repositories/accountRepository");
const projectionRepository = require("../repositories/projectionRepository");
const { checkAccountAccess } = require("../services/hubResourceAccessService");
const { todaySp, ymd } = require("../services/rankingRules");

const CACHE_TTL_SEC = 300;
const cache = new Map();
const CANCELLED = new Set(["cancelled", "canceled"]);
const STATUS_RE = /^[a-z][a-z_ -]{0,39}$/;

function badRequest(message) { return Object.assign(new Error(message), { status: 400 }); }
function accountIdOf(value) { const id = Number.parseInt(String(value == null ? "" : value), 10); return Number.isFinite(id) && id > 0 ? id : null; }

function monthInfo(periodInput, now = new Date()) {
  const today = todaySp(now);
  const currentKey = ymd(today).slice(0, 7);
  const key = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(periodInput || "")) ? String(periodInput) : currentKey;
  const [year, month] = key.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  const daysInMonth = end.getUTCDate();
  const isCurrent = key === currentKey;
  const isFuture = key > currentKey;
  const dayOfMonth = isCurrent ? today.getUTCDate() : isFuture ? 0 : daysInMonth;
  return { key, year, month, start: ymd(start), end: ymd(end), daysInMonth, dayOfMonth, isCurrent, isFuture, today: ymd(today) };
}

function previousMonthKey(info) {
  const d = new Date(Date.UTC(info.year, info.month - 2, 1));
  return ymd(d).slice(0, 7);
}

// Serie diaria completa do mes (dias sem venda com zero).
function fillDays(rows, info) {
  const byDay = new Map(rows.map((row) => [Number(row.day.slice(8, 10)), row]));
  return Array.from({ length: info.daysInMonth }, (_, index) => {
    const row = byDay.get(index + 1);
    return { day: index + 1, revenue: row ? Math.round(row.revenue * 100) / 100 : 0, orders: row ? row.orders : 0 };
  });
}

function sum(rows, key, count = rows.length) { return rows.slice(0, count).reduce((total, row) => total + Number(row[key] || 0), 0); }

function buildProjection({ info, previousInfo, currentRows, previousRows, units, statusRows, fulfillment, statuses, available }) {
  const daily = fillDays(currentRows, info);
  const previousDaily = fillDays(previousRows, previousInfo);
  const revenue = sum(daily, "revenue", info.dayOfMonth);
  const orders = sum(daily, "orders", info.dayOfMonth);
  const closedDays = info.isCurrent ? Math.max(0, info.dayOfMonth - 1) : info.dayOfMonth;
  const comparableDays = Math.min(info.dayOfMonth, previousInfo.daysInMonth);
  const previousRevenue = sum(previousDaily, "revenue");
  const previousOrders = sum(previousDaily, "orders");
  const previousComparableRevenue = sum(previousDaily, "revenue", comparableDays);
  const previousComparableOrders = sum(previousDaily, "orders", comparableDays);
  const projected = info.isFuture ? 0 : info.isCurrent && info.dayOfMonth > 0 ? (revenue / info.dayOfMonth) * info.daysInMonth : revenue;
  const round = (value) => Math.round(value * 100) / 100;
  return {
    ok: true,
    period: { month_key: info.key, year: info.year, month: info.month, day_of_month: info.dayOfMonth, days_in_month: info.daysInMonth, is_current_month: info.isCurrent, today: info.today, from: info.start, to: info.end },
    filter: { statuses, available },
    totals: {
      revenue: round(revenue), orders, units, ticket: orders ? round(revenue / orders) : 0, projected: round(projected),
      closed_days: closedDays,
      avg_revenue_closed: closedDays ? round(sum(daily, "revenue", closedDays) / closedDays) : 0,
      avg_orders_closed: closedDays ? Math.round((sum(daily, "orders", closedDays) / closedDays) * 100) / 100 : 0,
    },
    previous: {
      month_key: previousInfo.key, days_in_month: previousInfo.daysInMonth, comparable_days: comparableDays,
      revenue: round(previousRevenue), orders: previousOrders,
      comparable_revenue: round(previousComparableRevenue), comparable_orders: previousComparableOrders,
      comparable_ticket: previousComparableOrders ? round(previousComparableRevenue / previousComparableOrders) : 0,
      avg_revenue: previousInfo.daysInMonth ? round(previousRevenue / previousInfo.daysInMonth) : 0,
      avg_orders: previousInfo.daysInMonth ? Math.round((previousOrders / previousInfo.daysInMonth) * 100) / 100 : 0,
    },
    series: { daily, previous_daily: previousDaily },
    composition: {
      by_status: statusRows.map((row) => ({ ...row, revenue: round(row.revenue), counted: statuses.includes(row.status) })),
      by_delivery: { full: { ...fulfillment.full, revenue: round(fulfillment.full.revenue) }, other: { ...fulfillment.other, revenue: round(fulfillment.other.revenue) } },
    },
  };
}

async function projection(req, res) {
  try {
    const id = accountIdOf(req.query?.account_id);
    if (!id) throw badRequest("Selecione uma conta Magalu.");
    const identity = req.magaluIdentity;
    const account = await accountRepository.findAccountByIdForTenant(id, identity.dachTenantId);
    if (!account) return res.status(404).json({ ok: false, message: "Conta Magalu não encontrada." });
    const access = await checkAccountAccess(identity, account, { action: "READ magalu" });
    if (!access.allow) return res.status(403).json({ ok: false, message: "O Hub não confirmou acesso à conta Magalu." });

    const info = monthInfo(req.query?.period);
    const previousInfo = monthInfo(previousMonthKey(info));
    const available = await projectionRepository.availableStatuses(account.id);
    const requested = String(req.query?.statuses || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (requested.some((value) => !STATUS_RE.test(value))) throw badRequest("Status inválido no filtro.");
    // Padrao: todos os status que a API trouxe, menos cancelado (mesma regra do Painel).
    const statuses = requested.length ? [...new Set(requested)] : available.map((row) => row.status).filter((status) => !CANCELLED.has(status));

    const key = JSON.stringify([account.id, info.key, statuses.slice().sort()]);
    const cached = cache.get(key);
    if (cached && Date.now() < cached.expiresAt && String(req.query?.fresh || "") !== "1") return res.json({ ...cached.payload, meta: { ...cached.payload.meta, cached: true } });

    const currentTo = info.isCurrent ? info.today : info.end;
    const [currentRows, previousRows, units, statusRows, fulfillment] = await Promise.all([
      info.isFuture ? [] : projectionRepository.dailySeries(account.id, { from: info.start, to: currentTo, statuses }),
      projectionRepository.dailySeries(account.id, { from: previousInfo.start, to: previousInfo.end, statuses }),
      info.isFuture ? 0 : projectionRepository.unitsSold(account.id, { from: info.start, to: currentTo, statuses }),
      info.isFuture ? [] : projectionRepository.statusBreakdown(account.id, { from: info.start, to: currentTo }),
      info.isFuture ? { full: { orders: 0, revenue: 0 }, other: { orders: 0, revenue: 0 } } : projectionRepository.fulfillmentBreakdown(account.id, { from: info.start, to: currentTo, statuses }),
    ]);
    const payload = buildProjection({ info, previousInfo, currentRows, previousRows, units, statusRows, fulfillment, statuses, available });
    payload.account = { name: account.magalu_tenant_name || null };
    payload.meta = { generated_at: new Date().toISOString(), cache_ttl_sec: CACHE_TTL_SEC, cached: false };
    cache.set(key, { payload, expiresAt: Date.now() + CACHE_TTL_SEC * 1000 });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return res.json(payload);
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("[magalu] projecao", error);
    return res.status(status).json({ ok: false, message: status >= 500 ? "Não foi possível calcular a projeção agora." : error.message });
  }
}

module.exports = { projection, _test: { monthInfo, previousMonthKey, fillDays, buildProjection } };
