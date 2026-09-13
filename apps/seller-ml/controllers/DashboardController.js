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

      const me = await getMe(accessToken);
      const sellerId = me?.id;

      if (!sellerId) {
        return res.status(400).json({
          ok: false,
          error: "Não foi possível identificar seller_id em /users/me.",
        });
      }

      const orders = await fetchAllPaidOrders(accessToken, sellerId, from, to);

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
