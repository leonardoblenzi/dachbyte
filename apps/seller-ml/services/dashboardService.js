"use strict";

/**
 * DashboardService
 * - Total do mês (pedidos pagos) via Orders API
 * - Ads (atribuído) via Product Ads (soma por campanha)
 *
 * Observações:
 * - Se Ads não estiver habilitado / escopo não existir / endpoint mudar, ele cai em ads.available=false
 * - Formato de resposta é o que a tela de projeção mensal já consome
 */

const _fetch = typeof fetch !== "undefined" ? fetch : require("node-fetch");
const fetchRef = (...args) => _fetch(...args);

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtDateYMD(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function getNowParts(timeZone) {
  // Usa Intl pra pegar ano/mês/dia do "agora" no timezone
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = dtf.formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
  };
}

function daysInMonth(year, month) {
  // month 1-12
  return new Date(year, month, 0).getDate();
}

function parsePeriod(periodStr, tz) {
  // periodStr: YYYY-MM (opcional)
  if (periodStr && /^\d{4}-\d{2}$/.test(periodStr)) {
    const [y, mm] = periodStr.split("-");
    const year = Number(y);
    const month = Number(mm);
    const dim = daysInMonth(year, month);

    // Se estiver olhando mês passado/futuro, “day_of_month” vira o último dia (pra projeção não ficar doida)
    const now = getNowParts(tz);
    const day_of_month =
      now.year === year && now.month === month ? now.day : dim;

    return { year, month, day_of_month, days_in_month: dim };
  }

  const now = getNowParts(tz);
  const dim = daysInMonth(now.year, now.month);
  return {
    year: now.year,
    month: now.month,
    day_of_month: now.day,
    days_in_month: dim,
  };
}

async function httpGetJson(url, accessToken, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetchRef(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          accept: "application/json",
        },
      });

      const ct = String(r.headers.get("content-type") || "");
      const isJson = ct.includes("application/json");

      const body = isJson ? await r.json().catch(() => null) : await r.text();

      if (!r.ok) {
        const msg =
          (body && body.message) ||
          (typeof body === "string" ? body.slice(0, 180) : "") ||
          `HTTP ${r.status}`;
        const err = new Error(msg);
        err.statusCode = r.status;
        err.payload = body;
        throw err;
      }

      return body;
    } catch (e) {
      lastErr = e;
      // retry simples
      if (i < retries) {
        await new Promise((r) => setTimeout(r, 350 * (i + 1)));
        continue;
      }
    }
  }
  throw lastErr;
}

/**
 * Orders:
 * /orders/search?seller={sellerId}&order.status=paid&date_created.from=...&date_created.to=...
 * (Formato exato pode variar por conta/permissão; aqui é “best-effort”)
 */
async function fetchAllPaidOrdersForMonth({
  accessToken,
  sellerId,
  dateFromIso,
  dateToIso,
  limit = 50,
  hardCap = 4000,
}) {
  const orders = [];
  let offset = 0;

  while (true) {
    const url =
      "https://api.mercadolibre.com/orders/search" +
      `?seller=${encodeURIComponent(String(sellerId))}` +
      `&order.status=paid` +
      `&date_created.from=${encodeURIComponent(dateFromIso)}` +
      `&date_created.to=${encodeURIComponent(dateToIso)}` +
      `&limit=${limit}` +
      `&offset=${offset}`;

    const data = await httpGetJson(url, accessToken, 2);

    const results = Array.isArray(data?.results) ? data.results : [];
    orders.push(...results);

    if (results.length < limit) break;

    offset += limit;
    if (orders.length >= hardCap) break;
  }

  return orders;
}

/**
 * Ads:
 * Como docs do ML Ads variam e às vezes bloqueiam acesso, usamos abordagem robusta:
 * 1) advertiser_site_id = siteId + sellerId (ex: MLB + 123456)
 * 2) lista campanhas
 * 3) busca métricas por campanha e soma "direct_amount" (atribuído)
 *
 * Se qualquer etapa falhar: ads.available=false + ads.error.
 */
async function fetchAdsAttributedRevenue({
  accessToken,
  advertiserSiteId,
  dateFromYMD,
  dateToYMD,
  maxCampaigns = 80,
}) {
  // Endpoint “provável” (já visto em implementações reais):
  // https://api.mercadolibre.com/marketplace/advertising/{ADVERTISER_SITE_ID}/product_ads/campaigns
  const listUrl = `https://api.mercadolibre.com/marketplace/advertising/${encodeURIComponent(
    advertiserSiteId
  )}/product_ads/campaigns?limit=50&offset=0`;

  const list = await httpGetJson(listUrl, accessToken, 1);

  // tenta achar campanhas em formatos diferentes
  const candidates =
    (Array.isArray(list) && list) ||
    (Array.isArray(list?.results) && list.results) ||
    (Array.isArray(list?.campaigns) && list.campaigns) ||
    [];

  const campaignIds = candidates
    .map((c) => c?.id ?? c?.campaign_id ?? c?.campaignId)
    .filter((x) => x != null)
    .slice(0, maxCampaigns);

  let directAmount = 0;
  let fetched = 0;
  let errors = 0;

  // Endpoint “provável” para métricas por campanha:
  // https://api.mercadolibre.com/marketplace/advertising/{ADVERTISER_SITE_ID}/product_ads/campaigns/{CAMPAIGN_ID}?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&metrics=direct_amount
  for (const id of campaignIds) {
    const metricsUrl =
      `https://api.mercadolibre.com/marketplace/advertising/${encodeURIComponent(
        advertiserSiteId
      )}/product_ads/campaigns/${encodeURIComponent(String(id))}` +
      `?date_from=${encodeURIComponent(dateFromYMD)}` +
      `&date_to=${encodeURIComponent(dateToYMD)}` +
      `&metrics=${encodeURIComponent("direct_amount")}`;

    try {
      const m = await httpGetJson(metricsUrl, accessToken, 0);

      // tenta formatos comuns:
      // - m.metrics.direct_amount
      // - m.results[0].direct_amount
      // - m.direct_amount
      const v =
        Number(m?.metrics?.direct_amount) ||
        Number(m?.results?.[0]?.direct_amount) ||
        Number(m?.direct_amount) ||
        0;

      directAmount += v;
      fetched++;
    } catch (e) {
      errors++;
      // segue a vida; se todas falharem, a gente derruba ads.available no caller
    }
  }

  return {
    direct_amount: directAmount,
    campaigns_total: campaignIds.length,
    campaigns_fetched: fetched,
    campaigns_errors: errors,
  };
}

class DashboardService {
  /**
   * Retorna exatamente o shape esperado pelo seu front.
   */
  static async getMonthlySales({ accessToken, tz, period, accountKey }) {
    const p = parsePeriod(period, tz || "America/Sao_Paulo");

    // range do mês (hoje até 23:59:59)
    const y = p.year;
    const m = p.month;
    const day = p.day_of_month;

    const dateFromYMD = fmtDateYMD(y, m, 1);
    const dateToYMD = fmtDateYMD(y, m, day);

    // Orders API costuma aceitar ISO completo; usamos -03:00 (Sao Paulo) por padrão.
    const dateFromIso = `${dateFromYMD}T00:00:00.000-03:00`;
    const dateToIso = `${dateToYMD}T23:59:59.999-03:00`;

    // 1) Quem é o seller
    const me = await httpGetJson(
      "https://api.mercadolibre.com/users/me",
      accessToken,
      2
    );

    const sellerId = me?.id;
    const siteId = me?.site_id || me?.siteId || me?.country_id || "MLB"; // fallback
    if (!sellerId) {
      const err = new Error(
        "Não foi possível identificar o seller (users/me)."
      );
      err.statusCode = 502;
      throw err;
    }

    // 2) Pedidos pagos do mês
    const orders = await fetchAllPaidOrdersForMonth({
      accessToken,
      sellerId,
      dateFromIso,
      dateToIso,
      limit: 50,
      hardCap: 6000,
    });

    let revenue = 0;
    let ordersCount = 0;
    let units = 0;

    // série diária
    const series = Array.from({ length: p.days_in_month }).map((_, idx) => ({
      date: fmtDateYMD(y, m, idx + 1),
      revenue: 0,
      orders: 0,
      units: 0,
    }));

    for (const o of orders) {
      ordersCount++;

      const amount =
        Number(o?.total_amount) ||
        Number(o?.paid_amount) ||
        Number(
          o?.order_items?.reduce?.(
            (acc, it) =>
              acc + (Number(it?.unit_price) || 0) * (Number(it?.quantity) || 0),
            0
          )
        ) ||
        0;

      revenue += amount;

      const items = Array.isArray(o?.order_items) ? o.order_items : [];
      for (const it of items) units += Number(it?.quantity || 0);

      // date_created geralmente vem como ISO; pegamos YYYY-MM-DD
      const dt = String(o?.date_created || "").slice(0, 10);
      if (dt && /^\d{4}-\d{2}-\d{2}$/.test(dt)) {
        // se o dt for do mês, soma
        if (dt.startsWith(`${y}-${pad2(m)}-`)) {
          const d = Number(dt.slice(8, 10));
          if (d >= 1 && d <= p.days_in_month) {
            series[d - 1].revenue += amount;
            series[d - 1].orders += 1;
            // units por pedido (somatório)
            const orderUnits = items.reduce(
              (acc, it) => acc + Number(it?.quantity || 0),
              0
            );
            series[d - 1].units += orderUnits;
          }
        }
      }
    }

    const avgDaily = revenue / Math.max(1, p.day_of_month);
    const projected = avgDaily * p.days_in_month;
    const ticket = revenue / Math.max(1, ordersCount);

    // 3) Ads (atribuído)
    let ads = {
      available: false,
      advertiser_site_id: null,
      date_from: dateFromYMD,
      date_to: dateToYMD,
      direct_amount: 0,
      error: null,
      debug: null,
    };

    try {
      const advertiserSiteId = `${String(siteId || "MLB")}${String(sellerId)}`;

      const adsData = await fetchAdsAttributedRevenue({
        accessToken,
        advertiserSiteId,
        dateFromYMD,
        dateToYMD,
        maxCampaigns: 80,
      });

      // Se não conseguiu buscar nenhuma campanha, consideramos indisponível
      if (adsData.campaigns_fetched > 0) {
        ads.available = true;
        ads.advertiser_site_id = advertiserSiteId;
        ads.direct_amount = Number(adsData.direct_amount || 0);
        ads.debug = adsData;
      } else {
        ads.available = false;
        ads.advertiser_site_id = advertiserSiteId;
        ads.direct_amount = 0;
        ads.error =
          "Não foi possível obter métricas de campanhas (Ads pode não estar habilitado/escopo insuficiente).";
        ads.debug = adsData;
      }
    } catch (e) {
      ads.available = false;
      ads.direct_amount = 0;
      ads.error = e.message || "Falha ao consultar Ads";
    }

    const totalAll = revenue;
    const adsDirect = ads.available ? ads.direct_amount : 0;
    const organicEstimated = Math.max(0, totalAll - adsDirect);

    return {
      ok: true,
      period: {
        tz: tz || "America/Sao_Paulo",
        year: y,
        month: m,
        day_of_month: p.day_of_month,
        days_in_month: p.days_in_month,
      },
      totals: {
        revenue_month_to_date: totalAll,
        revenue_projected_month: projected,
        avg_daily_revenue: avgDaily,
        orders_count: ordersCount,
        units_sold: units,
        ticket_medio: ticket,
      },
      breakdown: {
        total_all: totalAll,
        ads_direct_amount: adsDirect,
        organic_estimated: organicEstimated,
      },
      ads,
      series: {
        daily_orders: series,
      },
      meta: {
        accountKey: accountKey || null,
        seller_id: sellerId,
        site_id: siteId || null,
        truncated: orders.length >= 6000,
      },
    };
  }
}

module.exports = DashboardService;
