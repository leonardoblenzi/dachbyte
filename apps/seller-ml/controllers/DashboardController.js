"use strict";

const _fetch = typeof fetch !== "undefined" ? fetch : require("node-fetch");
const fetchRef = (...args) => _fetch(...args);

function pickAccessToken(req) {
  const t = req?.ml?.accessToken;
  if (!t) {
    const err = new Error(
      "Token ML ausente em req.ml.accessToken (authMiddleware não injetou)."
    );
    err.statusCode = 401;
    throw err;
  }
  return t;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isYYYYMM(s) {
  return /^\d{4}-\d{2}$/.test(String(s || ""));
}

function daysInMonth(year, month1to12) {
  return new Date(year, month1to12, 0).getDate(); // month=2 => last day of Feb
}

function todayInTZ(tz) {
  // pega data "local" no tz e retorna YYYY-MM-DD
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;

  return `${y}-${m}-${d}`;
}

function monthKeyFromISO(iso) {
  return String(iso || "").slice(0, 7);
}

// Brasil atualmente é -03:00 (sem DST). Mantemos fixo aqui.
function isoStartOfDayBR(dateISO) {
  return `${dateISO}T00:00:00.000-03:00`;
}
function isoEndOfDayBR(dateISO) {
  return `${dateISO}T23:59:59.999-03:00`;
}

async function httpGetJson(url, accessToken, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetchRef(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const text = await r.text().catch(() => "");
      const data = text ? JSON.parse(text) : null;

      if (!r.ok) {
        const msg =
          (data && (data.message || data.error || data.cause?.[0]?.message)) ||
          `HTTP ${r.status}`;
        const e = new Error(msg);
        e.statusCode = r.status;
        e.payload = data;
        throw e;
      }

      return data;
    } catch (e) {
      lastErr = e;
      // retry simples
      if (i < retries) await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw lastErr;
}

async function getMe(accessToken) {
  return httpGetJson("https://api.mercadolibre.com/users/me", accessToken, 1);
}

// Cache dos pedidos do mes por seller (todos os status). Trocar o filtro de status
// e montar o mes anterior reaproveitam o que ja veio da API; "Atualizar" (fresh=1) busca de novo.
const ORDERS_CACHE = new Map();
const ME_CACHE = new Map();
const CURRENT_MONTH_TTL_MS = 5 * 60 * 1000;
const CLOSED_MONTH_TTL_MS = 6 * 60 * 60 * 1000;

function slimOrder(o) {
  return {
    status: o?.status || null,
    date_created: o?.date_created || null,
    date_closed: o?.date_closed || null,
    paid_amount: o?.paid_amount ?? null,
    total_amount: o?.total_amount ?? null,
    payments: Array.isArray(o?.payments) && o.payments[0] ? [{ total_paid_amount: o.payments[0].total_paid_amount ?? null }] : [],
    order_items: (Array.isArray(o?.order_items) ? o.order_items : []).map((it) => ({ quantity: Number(it?.quantity || 0) })),
  };
}

async function getMeCached(accessToken) {
  const key = String(accessToken || "").slice(-32);
  const hit = ME_CACHE.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.me;
  const me = await getMe(accessToken);
  ME_CACHE.set(key, { me: { id: me?.id, site_id: me?.site_id }, expiresAt: Date.now() + 10 * 60 * 1000 });
  if (ME_CACHE.size > 500) ME_CACHE.delete(ME_CACHE.keys().next().value);
  return me;
}

async function fetchMonthOrdersCached(accessToken, sellerId, from, to, { closedMonth = false, fresh = false } = {}) {
  const key = `${sellerId}:${from}:${to}`;
  const hit = ORDERS_CACHE.get(key);
  if (!fresh && hit && Date.now() < hit.expiresAt) return { orders: hit.orders, cached: true, fetchedAt: hit.fetchedAt };
  const orders = (await fetchAllOrders(accessToken, sellerId, from, to)).map(slimOrder);
  const fetchedAt = new Date().toISOString();
  ORDERS_CACHE.set(key, { orders, fetchedAt, expiresAt: Date.now() + (closedMonth ? CLOSED_MONTH_TTL_MS : CURRENT_MONTH_TTL_MS) });
  if (ORDERS_CACHE.size > 300) ORDERS_CACHE.delete(ORDERS_CACHE.keys().next().value);
  return { orders, cached: false, fetchedAt };
}

// Status do pedido aceitos no filtro da Projecao mensal (padrao: so pagos, como antes).
const DEFAULT_PROJECTION_STATUSES = ["paid"];
const CANCELLED_STATUSES = new Set(["cancelled"]);
function parseStatuses(raw) {
  const list = String(raw || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (list.some((value) => !/^[a-z_]{2,40}$/.test(value))) {
    const err = new Error("Status inválido no filtro.");
    err.statusCode = 400;
    throw err;
  }
  return list.length ? [...new Set(list)] : DEFAULT_PROJECTION_STATUSES.slice();
}

function orderAmount(order) {
  return Number(order?.paid_amount) || Number(order?.total_amount) || Number(order?.payments?.[0]?.total_paid_amount) || 0;
}

// Todos os pedidos do periodo, de qualquer status (uma busca so; o filtro e local).
async function fetchAllOrders(accessToken, sellerId, fromISO, toISO) {
  const out = [];
  const limit = 50;
  let offset = 0;
  let total = Infinity;
  while (offset < total && offset < 9950) {
    const url =
      "https://api.mercadolibre.com/orders/search" +
      `?seller=${encodeURIComponent(String(sellerId))}` +
      `&order.date_created.from=${encodeURIComponent(fromISO)}` +
      `&order.date_created.to=${encodeURIComponent(toISO)}` +
      `&sort=date_desc` +
      `&limit=${limit}` +
      `&offset=${offset}`;
    const data = await httpGetJson(url, accessToken, 1);
    const results = Array.isArray(data?.results) ? data.results : [];
    out.push(...results);
    const pagingTotal = Number(data?.paging?.total ?? results.length);
    total = isFinite(pagingTotal) ? pagingTotal : out.length;
    if (results.length < limit) break;
    offset += limit;
  }
  return out;
}

async function fetchAllPaidOrders(accessToken, sellerId, fromISO, toISO) {
  const out = [];
  const limit = 50;
  let offset = 0;
  let total = Infinity;

  // filtros mais comuns suportados: seller + order.status + range por date_created
  // (se você quiser trocar pra date_closed depois, a gente ajusta)
  while (offset < total && offset < 5000) {
    const url =
      "https://api.mercadolibre.com/orders/search" +
      `?seller=${encodeURIComponent(String(sellerId))}` +
      `&order.status=paid` +
      `&order.date_created.from=${encodeURIComponent(fromISO)}` +
      `&order.date_created.to=${encodeURIComponent(toISO)}` +
      `&sort=date_desc` +
      `&limit=${limit}` +
      `&offset=${offset}`;

    const data = await httpGetJson(url, accessToken, 1);

    const results = Array.isArray(data?.results) ? data.results : [];
    out.push(...results);

    const pagingTotal = Number(data?.paging?.total ?? results.length);
    total = isFinite(pagingTotal) ? pagingTotal : out.length;

    if (results.length < limit) break;
    offset += limit;
  }

  return out;
}

function buildDailySeries(year, month, days) {
  const mm = pad2(month);
  const daily = [];
  for (let d = 1; d <= days; d++) {
    const dd = pad2(d);
    daily.push({
      date: `${year}-${mm}-${dd}`,
      revenue: 0,
      orders: 0,
      units: 0,
    });
  }
  return daily;
}

class DashboardController {
  static async summary(req, res) {
    try {
      const tz = String(req.query.tz || "America/Sao_Paulo");

      const accessToken = pickAccessToken(req);

      const todayISO = todayInTZ(tz);
      const currentMonthKey = monthKeyFromISO(todayISO);

      const periodQ = String(req.query.period || "").trim();
      const targetMonthKey = isYYYYMM(periodQ) ? periodQ : currentMonthKey;

      const [yy, mm] = targetMonthKey.split("-").map((x) => parseInt(x, 10));
      const dim = daysInMonth(yy, mm);

      const isCurrentMonth = targetMonthKey === currentMonthKey;
      const todayDay = parseInt(String(todayISO).slice(8, 10), 10);

      // dia "efetivo" pro cálculo (se mês atual, usa dia atual; se mês fechado, usa último dia)
      const dayOfMonth = isCurrentMonth ? todayDay : dim;

      const monthStartISO = `${targetMonthKey}-01`;
      const monthEndISO = `${targetMonthKey}-${pad2(dim)}`;

      const from = isoStartOfDayBR(monthStartISO);
      const to = isoEndOfDayBR(isCurrentMonth ? todayISO : monthEndISO);

      const me = await getMeCached(accessToken);
      const sellerId = me?.id;

      if (!sellerId) {
        return res.status(400).json({
          ok: false,
          error: "Não foi possível identificar seller_id em /users/me.",
        });
      }

      const statuses = parseStatuses(req.query.statuses);
      const monthOrders = await fetchMonthOrdersCached(accessToken, sellerId, from, to, {
        closedMonth: !isCurrentMonth,
        fresh: String(req.query.fresh || "") === "1",
      });
      const allOrders = monthOrders.orders;
      const statusSet = new Set(statuses);
      const availableMap = new Map();
      for (const o of allOrders) {
        const status = String(o?.status || "sem_status").toLowerCase();
        availableMap.set(status, (availableMap.get(status) || 0) + 1);
      }
      const orders = allOrders.filter((o) => statusSet.has(String(o?.status || "sem_status").toLowerCase()));

      // Cancelados acompanhados a parte (sempre, independente do filtro), no dia da compra.
      const cancelledDaily = buildDailySeries(yy, mm, dim);
      const cancelledIndex = new Map(cancelledDaily.map((x, i) => [x.date, i]));
      let cancelledOrders = 0;
      let cancelledValue = 0;
      for (const o of allOrders) {
        if (!CANCELLED_STATUSES.has(String(o?.status || "").toLowerCase())) continue;
        const value = Number(o?.total_amount) || orderAmount(o);
        cancelledOrders += 1;
        cancelledValue += value;
        const idx = cancelledIndex.get(String(o?.date_created || "").slice(0, 10));
        if (idx != null) {
          cancelledDaily[idx].revenue += value;
          cancelledDaily[idx].orders += 1;
        }
      }

      // daily series
      const daily = buildDailySeries(yy, mm, dim);
      const indexByDate = new Map(daily.map((x, i) => [x.date, i]));

      let revenue = 0;
      let ordersCount = 0;
      let units = 0;

      for (const o of orders) {
        ordersCount += 1;

        const paidAmount =
          Number(o?.paid_amount) ||
          Number(o?.total_amount) ||
          Number(o?.payments?.[0]?.total_paid_amount) ||
          0;

        revenue += paidAmount;

        const items = Array.isArray(o?.order_items) ? o.order_items : [];
        for (const it of items) units += Number(it?.quantity || 0);

        // usa date_closed se existir; senão date_created
        const dateRaw = String(o?.date_closed || o?.date_created || "").slice(
          0,
          10
        );
        const idx = indexByDate.get(dateRaw);
        if (idx != null) {
          daily[idx].revenue += paidAmount;
          daily[idx].orders += 1;
          // units por dia (soma qty)
          let u = 0;
          for (const it of items) u += Number(it?.quantity || 0);
          daily[idx].units += u;
        }
      }

      const avgDaily = dayOfMonth > 0 ? revenue / dayOfMonth : 0;
      const projected = avgDaily * dim;
      const ticket = ordersCount > 0 ? revenue / ordersCount : 0;

      return res.json({
        ok: true,
        period: {
          year: yy,
          month: mm,
          day_of_month: dayOfMonth,
          days_in_month: dim,
          today: todayISO,
          month_key: targetMonthKey,
          is_current_month: isCurrentMonth,
        },
        totals: {
          revenue_month_to_date: revenue,
          revenue_projected_month: projected,
          avg_daily_revenue: avgDaily,
          orders_count: ordersCount,
          units_sold: units,
          ticket_medio: ticket,
        },
        breakdown: {
          // total do mês (até hoje, se mês atual)
          total_all: revenue,
          // Ads e orgânico vão ser preenchidos no frontend (via /api/publicidade)
          ads_direct_amount: 0,
          organic_estimated: revenue,
        },
        ads: {
          available: false,
          error: "Ads será calculado via /api/publicidade (frontend).",
        },
        series: {
          daily_orders: daily,
          cancelled_daily: cancelledDaily,
        },
        filter: {
          statuses,
          available: [...availableMap.entries()].sort((a, b) => b[1] - a[1]).map(([status, count]) => ({ status, orders: count })),
          truncated: allOrders.length >= 9950,
        },
        cache: { cached: monthOrders.cached, fetched_at: monthOrders.fetchedAt },
        cancellations: {
          orders: cancelledOrders,
          value: cancelledValue,
          share_of_orders: allOrders.length ? cancelledOrders / allOrders.length : 0,
          all_orders: allOrders.length,
        },
      });
    } catch (e) {
      const status = e.statusCode || 500;
      return res.status(status).json({
        ok: false,
        error: e.message || "Erro ao gerar dashboard",
      });
    }
  }
}

module.exports = DashboardController;
module.exports._test = { parseStatuses, orderAmount, slimOrder, fetchMonthOrdersCached, ORDERS_CACHE };
