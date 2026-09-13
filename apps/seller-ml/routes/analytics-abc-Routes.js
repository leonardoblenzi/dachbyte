// routes/analytics-abc-Routes.js
// Curva ABC em tempo real via API do Mercado Livre (sem banco)
// ✅ NOVO PADRÃO: conta vem do cookie (meli_conta_id) via ensureAccount
// ✅ token vem do authMiddleware (req.ml.accessToken)

"use strict";

const express = require("express");
const router = express.Router();

const _fetch = typeof fetch !== "undefined" ? fetch : require("node-fetch");
const fetchRef = (...args) => _fetch(...args);

/** Utils */
function isoStart(d) {
  return `${d}T00:00:00.000-00:00`;
}
function isoEnd(d) {
  return `${d}T23:59:59.999-00:00`;
}

/** Shift de YYYY-MM-DD em dias (UTC) */
function ymdShift(ymd, days) {
  const [y, m, d] = (ymd || "").split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + (days || 0));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
function ymdMin(a, b) {
  return new Date(a) <= new Date(b) ? a : b;
}

/** Diferença de dias (inteiros) por DIA-UTC entre âncora (YYYY-MM-DD) e ISO do pedido */
function daysDiffFromAnchorUTC(anchorYMD, iso) {
  if (!anchorYMD || !iso) return Infinity;
  const [ay, am, ad] = anchorYMD.split("-").map(Number);
  const anchorDayMs = Date.UTC(ay, (am || 1) - 1, ad || 1);
  const d = new Date(iso);
  const orderDayMs = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate()
  );
  return Math.floor((anchorDayMs - orderDayMs) / 86400000);
}
function inRangeUTC(iso, fromYMD, toYMD) {
  const ms = new Date(iso).getTime();
  return (
    ms >= new Date(isoStart(fromYMD)).getTime() &&
    ms <= new Date(isoEnd(toYMD)).getTime()
  );
}

/** Boolean query helper (aceita 1, true, yes, on) */
function parseBoolParam(v, def = false) {
  if (v === undefined || v === null) return def;
  const s = String(v).toLowerCase().trim();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return def;
}

/** ✅ NOVO: pega token já validado pelo authMiddleware */
function getTokenFromRequest(req, res) {
  const t =
    req?.ml?.accessToken ||
    res?.locals?.accessToken ||
    req?.access_token ||
    null;

  if (!t) {
    const hint =
      res?.locals?.accountKey || res?.locals?.mlCreds?.meli_conta_id || "—";
    throw new Error(
      `[${hint}] Token ML ausente no request. Verifique ensureAccount + authMiddleware antes de /api/analytics.`
    );
  }
  return t;
}

/** Seller ID do token */
async function getSellerId(token) {
  const r = await fetchRef("https://api.mercadolibre.com/users/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`users/me ${r.status}`);
  const me = await r.json();
  return me.id;
}

/** FULL? */
function isFull(order) {
  return order?.shipping?.logistic_type === "fulfillment";
}

/** Paginador de pedidos pagos no intervalo solicitado */
async function* iterOrders({ token, sellerId, date_from, date_to }) {
  let offset = 0;
  const limit = 50;

  for (;;) {
    const url = new URL("https://api.mercadolibre.com/orders/search");
    url.searchParams.set("seller", sellerId);
    url.searchParams.set("order.status", "paid");
    url.searchParams.set("order.date_created.from", isoStart(date_from));
    url.searchParams.set("order.date_created.to", isoEnd(date_to));
    url.searchParams.set("sort", "date_desc");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    let attempts = 0;
    for (;;) {
      attempts++;
      try {
        const r = await fetchRef(url, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (r.status === 429) {
          if (attempts >= 5) throw new Error("Rate limited (429) repetido");
          await new Promise((res) => setTimeout(res, 400 * attempts));
          continue;
        }
        if (!r.ok) throw new Error(`orders/search ${r.status}`);
        const data = await r.json();
        for (const o of data.results || []) yield o;

        offset += limit;
        if (offset >= (data.paging?.total || 0)) return;
        break;
      } catch (e) {
        if (attempts >= 3) throw e;
        await new Promise((res) => setTimeout(res, 300 * attempts));
      }
    }
  }
}

/** Key de agregação */
function makeKey({ mlb, sku }, group_by) {
  if (group_by === "mlb") return String(mlb);
  return `${mlb}|${sku || ""}`;
}

/** Classificação ABC */
function classifyABC(rows, { metric = "units", aCut = 0.8, bCut = 0.95 } = {}) {
  const sorted = rows
    .slice()
    .sort((x, y) => (y[metric] || 0) - (x[metric] || 0));
  const total = sorted.reduce((s, r) => s + (r[metric] || 0), 0) || 1;
  let cum = 0;
  for (const r of sorted) {
    cum += r[metric] || 0;
    const share = cum / total;
    r.share_cum = share;
    r.curve = share <= aCut ? "A" : share <= bCut ? "B" : "C";
  }
  return { total, rows: sorted };
}

/** Defaults (✅ sem accounts) */
function parseCommonQuery(q) {
  const hasMetric = typeof q.metric === "string";
  const hasGroupBy = typeof q.group_by === "string";
  const hasACut = Object.prototype.hasOwnProperty.call(q, "a_cut");
  const hasBCut = Object.prototype.hasOwnProperty.call(q, "b_cut");

  return {
    date_from: q.date_from,
    date_to: q.date_to,

    metric: hasMetric
      ? q.metric === "revenue"
        ? "revenue"
        : "units"
      : "revenue",
    group_by: hasGroupBy ? (q.group_by === "mlb" ? "mlb" : "mlb_sku") : "mlb",

    a_cut:
      !hasACut || isNaN(parseFloat(q.a_cut))
        ? 0.75
        : Math.max(0.5, Math.min(0.95, parseFloat(q.a_cut))),

    b_cut:
      !hasBCut || isNaN(parseFloat(q.b_cut))
        ? 0.92
        : Math.max(0.7, Math.min(0.99, parseFloat(q.b_cut))),

    min_units: Math.max(1, parseInt(q.min_units || "1", 10)),
    full: q.full || "all",
  };
}

/** ------- HTTP helper + ADS v2 helpers ------- */

/** GET JSON com retry simples + coleta de debug */
async function httpGetJson(url, headers, retries = 3, dbgArr = null) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const r = await fetchRef(url, { headers });
    const status = r.status;
    const text = await r.text();
    if (dbgArr) {
      dbgArr.push({
        type: "http",
        url,
        status,
        body: text.slice(0, 1024),
      });
    }
    if (status === 429 || (status >= 500 && status < 600)) {
      await new Promise((res) => setTimeout(res, 400 * (i + 1)));
      continue;
    }
    if (!r.ok) {
      lastErr = new Error(`GET ${url} -> ${status}`);
      break;
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      break;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

/** VISITS */
async function fetchVisitsForItems({
  token,
  itemIds,
  date_from,
  date_to,
  dbgArr,
}) {
  const out = {};
  const ids = Array.from(
    new Set(
      (itemIds || []).map((id) => String(id).toUpperCase()).filter(Boolean)
    )
  );
  if (!ids.length) return out;

  const toYMD = (d) => {
    if (!d) return null;
    if (typeof d === "string") return d.slice(0, 10);
    try {
      return d.toISOString().slice(0, 10);
    } catch {
      return null;
    }
  };

  const df = toYMD(date_from);
  const dt = toYMD(date_to);

  const CHUNK = 1;

  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);

    const qs = new URLSearchParams();
    qs.set("ids", slice.join(","));
    qs.set("date_from", df);
    qs.set("date_to", dt);
    qs.set("unit", "day");
    if (token) qs.set("access_token", token);

    const url = `https://api.mercadolibre.com/items/visits?${qs.toString()}`;

    try {
      const j = await httpGetJson(url, {}, 2, dbgArr);

      const arr = Array.isArray(j)
        ? j
        : Array.isArray(j?.results)
        ? j.results
        : [];

      for (const v of arr) {
        const itemId = String(v.item_id || v.id || "").toUpperCase();
        if (!itemId) continue;

        let total = 0;

        const sumArr = (arr) =>
          arr.reduce(
            (s, d) => s + Number(d?.visits ?? d?.total ?? d?.total_visits ?? 0),
            0
          );

        if (v.total_visits != null) total = Number(v.total_visits);
        else if (v.total != null) total = Number(v.total);
        else if (Array.isArray(v.visits_detail))
          total = sumArr(v.visits_detail);
        else if (Array.isArray(v.visits)) total = sumArr(v.visits);
        else if (Array.isArray(v.data)) total = sumArr(v.data);

        if (!Number.isFinite(total) || total < 0) continue;
        out[itemId] = { visits_total: total };
      }
    } catch (e) {
      if (dbgArr) {
        dbgArr.push({
          type: "visits_error",
          slice: slice.join(","),
          message: e.message || String(e),
        });
      }
    }
  }

  return out;
}

/** ADS v2 */
function getAdvertiserIdFromConfig(req, site) {
  const qKey = `adv_id_${site}`;
  if (req.query && req.query[qKey]) return String(req.query[qKey]);

  const envKey = `ADS_ADV_ID_${site}`;
  if (process.env[envKey]) return String(process.env[envKey]);

  if (process.env.ADS_ADV_ID_MAP) {
    try {
      const m = JSON.parse(process.env.ADS_ADV_ID_MAP);
      if (m && m[site]) return String(m[site]);
    } catch {}
  }
  return null;
}

async function getAdvertisersForToken(token, dbgArr) {
  const url =
    "https://api.mercadolibre.com/advertising/advertisers?product_id=PADS";
  try {
    const j = await httpGetJson(
      url,
      {
        Authorization: `Bearer ${token}`,
        "Api-Version": "1",
        "Content-Type": "application/json",
      },
      2,
      dbgArr
    );
    const list = Array.isArray(j?.advertisers) ? j.advertisers : [];
    const map = new Map();
    for (const a of list) {
      if (!map.has(a.site_id)) map.set(a.site_id, a.advertiser_id);
    }
    return map;
  } catch (e) {
    if (dbgArr)
      dbgArr.push({ type: "advertisers_error", url, message: e.message });
    return new Map();
  }
}

async function fetchItemStatus({ token, site, itemId, dbgArr }) {
  const url = `https://api.mercadolibre.com/advertising/${site}/product_ads/items/${itemId}`;
  try {
    const json = await httpGetJson(
      url,
      { Authorization: `Bearer ${token}`, "api-version": "2" },
      2,
      dbgArr
    );
    const raw = String(json?.status || "").toLowerCase();
    if (raw === "active") return "active";
    if (raw === "paused") return "paused";
    return "none";
  } catch (e) {
    if (dbgArr)
      dbgArr.push({ type: "item_status_error", url, message: e.message });
    return "none";
  }
}

async function fetchAdsMetricsSingle({
  token,
  site,
  itemId,
  date_from,
  date_to,
  channels = ["marketplace"],
  dbgArr,
}) {
  let clicks = 0,
    prints = 0,
    cost = 0,
    acos = null,
    total_amount = 0,
    direct_amount = 0,
    indirect_amount = 0;

  const metrics =
    "clicks,prints,cost,acos,total_amount,direct_amount,indirect_amount,units_quantity";
  const base = `https://api.mercadolibre.com/advertising/${site}/product_ads/ads/${itemId}`;
  const headers = { Authorization: `Bearer ${token}`, "api-version": "2" };
  const counted = new Set();

  async function tryChannel(requestedChannel) {
    const qs = new URLSearchParams({
      date_from,
      date_to,
      metrics,
      metrics_summary: "true",
      channel: requestedChannel,
    }).toString();
    const url = `${base}?${qs}`;
    const j = await httpGetJson(url, headers, 2, dbgArr);

    const respChannel = String(j?.channel || "").toLowerCase();
    if (respChannel) {
      if (counted.has(respChannel)) return;
      if (requestedChannel && respChannel !== requestedChannel) return;
      counted.add(respChannel);
    } else {
      if (counted.has(requestedChannel || "unknown")) return;
      counted.add(requestedChannel || "unknown");
    }

    const m = j?.metrics_summary || j?.metrics || j || {};
    clicks += Number(m.clicks || 0);
    prints += Number(m.prints || 0);
    cost += Number(m.cost || 0);
    total_amount += Number(m.total_amount || 0);
    direct_amount += Number(m.direct_amount || 0);
    indirect_amount += Number(m.indirect_amount || 0);
    if (m.acos != null) acos = Number(m.acos);
  }

  for (const ch of channels) {
    try {
      await tryChannel(ch);
    } catch {}
  }

  const spend_cents = Math.round(cost * 100);
  const revenue_amount =
    total_amount > 0 ? total_amount : direct_amount + indirect_amount;
  const revenue_cents = Math.round(revenue_amount * 100);
  const had_activity = clicks + prints + spend_cents + revenue_cents > 0;

  return { clicks, prints, spend_cents, revenue_cents, acos, had_activity };
}

async function fetchAdsMetricsByItems({
  req,
  token,
  itemIds,
  date_from,
  date_to,
  channels = ["marketplace"],
  dbgAcc,
}) {
  const out = {};
  const ids = Array.from(
    new Set((itemIds || []).map((x) => String(x).toUpperCase()).filter(Boolean))
  );
  if (!ids.length) return out;

  const bySite = new Map();
  for (const id of ids) {
    const site = id.slice(0, 3);
    if (!bySite.has(site)) bySite.set(site, []);
    bySite.get(site).push(id);
  }

  const advertisersMap = await getAdvertisersForToken(token, dbgAcc.calls);

  for (const [site, arr] of bySite.entries()) {
    const forcedAdvertiser = getAdvertiserIdFromConfig(req, site);
    const advertiserId = forcedAdvertiser || advertisersMap.get(site) || null;

    if (advertiserId) {
      const CHUNK = 100;
      for (let i = 0; i < arr.length; i += CHUNK) {
        const slice = arr.slice(i, i + CHUNK);
        const agg = new Map();

        for (const channel of channels) {
          const qs = new URLSearchParams({
            limit: String(slice.length),
            offset: "0",
            date_from,
            date_to,
            metrics:
              "clicks,prints,cost,acos,total_amount,direct_amount,indirect_amount",
            metrics_summary: "true",
            aggregation: "sum",
          });
          qs.set("filters[item_id]", slice.join(","));
          qs.set("filters[channel]", channel);

          const url =
            `https://api.mercadolibre.com/advertising/${site}/advertisers/${advertiserId}/product_ads/ads/search?` +
            qs.toString();

          try {
            const json = await httpGetJson(
              url,
              { Authorization: `Bearer ${token}`, "api-version": "2" },
              2,
              dbgAcc.calls
            );
            const results = Array.isArray(json?.results) ? json.results : [];
            for (const r of results) {
              const itemId = String(r.item_id || "").toUpperCase();
              const prev = agg.get(itemId) || {
                clicks: 0,
                prints: 0,
                cost: 0,
                total_amount: 0,
                direct_amount: 0,
                indirect_amount: 0,
                status_code: "none",
              };
              const m = r.metrics || {};
              prev.clicks += Number(m.clicks || 0);
              prev.prints += Number(m.prints || 0);
              prev.cost += Number(m.cost || 0);
              prev.total_amount += Number(m.total_amount || 0);
              prev.direct_amount += Number(m.direct_amount || 0);
              prev.indirect_amount += Number(m.indirect_amount || 0);

              const raw = String(r.status || "").toLowerCase();
              const st =
                raw === "active"
                  ? "active"
                  : raw === "paused"
                  ? "paused"
                  : "none";
              prev.status_code =
                prev.status_code === "active" || st === "active"
                  ? "active"
                  : prev.status_code === "paused" || st === "paused"
                  ? "paused"
                  : "none";

              agg.set(itemId, prev);
            }
          } catch (e) {
            dbgAcc.calls.push({ type: "batch_error", url, message: e.message });
          }
        }

        for (const [itemId, v] of agg.entries()) {
          const spend_cents = Math.round(v.cost * 100);
          const revenue_amount =
            v.total_amount > 0
              ? v.total_amount
              : v.direct_amount + v.indirect_amount;
          const revenue_cents = Math.round(revenue_amount * 100);
          const acos = revenue_cents > 0 ? spend_cents / revenue_cents : null;
          const had_activity =
            v.clicks + v.prints + spend_cents + revenue_cents > 0;
          const status_text =
            v.status_code === "active"
              ? "Ativo"
              : v.status_code === "paused"
              ? "Pausado"
              : "Não";

          out[itemId] = {
            status_code: v.status_code,
            status_text,
            in_campaign: v.status_code !== "none",
            had_activity,
            clicks: v.clicks,
            impressions: v.prints,
            spend_cents,
            revenue_cents,
            acos,
          };
        }
      }
    }

    const missing = arr.filter((id) => !out[id]);
    dbgAcc.missingAfterSearch.push(...missing);

    for (const itemId of missing) {
      try {
        const status_code = await fetchItemStatus({
          token,
          site,
          itemId,
          dbgArr: dbgAcc.calls,
        });
        const status_text =
          status_code === "active"
            ? "Ativo"
            : status_code === "paused"
            ? "Pausado"
            : "Não";

        const m = await fetchAdsMetricsSingle({
          token,
          site,
          itemId,
          date_from,
          date_to,
          channels,
          dbgArr: dbgAcc.calls,
        });
        out[itemId] = {
          status_code,
          status_text,
          in_campaign: status_code !== "none",
          had_activity: m.had_activity,
          clicks: m.clicks,
          impressions: m.prints,
          spend_cents: m.spend_cents,
          revenue_cents: m.revenue_cents,
          acos:
            m.acos != null
              ? m.acos
              : m.revenue_cents > 0
              ? m.spend_cents / m.revenue_cents
              : null,
        };
      } catch (e) {
        dbgAcc.calls.push({
          type: "single_error",
          message: e.message,
          item: itemId,
        });
        out[itemId] = {
          status_code: "none",
          status_text: "Não",
          in_campaign: false,
          had_activity: false,
          clicks: 0,
          impressions: 0,
          spend_cents: 0,
          revenue_cents: 0,
          acos: null,
        };
      }
    }
  }

  return out;
}

/** ------- PROMO helpers ------- */
function mergePromo(a, b) {
  const A = a || { active: false, percent: null, source: null };
  const B = b || { active: false, percent: null, source: null };
  const aPct = A.percent != null ? Number(A.percent) : null;
  const bPct = B.percent != null ? Number(B.percent) : null;

  if (A.active && !B.active) return A;
  if (B.active && !A.active) return B;

  if (aPct != null && bPct != null) return bPct > aPct ? B : A;
  if (bPct != null && aPct == null) return B;
  return A;
}

async function fetchItemPromoNow({ token, itemId, dbgArr }) {
  const url = `https://api.mercadolibre.com/items/${itemId}/prices`;

  const pct = (full, price) => {
    const f = Number(full || 0),
      p = Number(price || 0);
    if (f > 0 && p > 0 && p < f) return 1 - p / f;
    return null;
  };

  try {
    const j = await httpGetJson(
      url,
      { Authorization: `Bearer ${token}` },
      2,
      dbgArr
    );

    const buckets = [];
    if (Array.isArray(j?.prices?.prices)) buckets.push(...j.prices.prices);
    if (Array.isArray(j?.prices)) buckets.push(...j.prices);
    if (Array.isArray(j?.reference_prices)) buckets.push(...j.reference_prices);

    const promoNodes = Array.isArray(j?.promotions) ? j.promotions : [];

    const nowMs = Date.now();
    const candidates = [];

    for (const p of buckets) {
      const t = String(p?.type || "").toLowerCase();
      if (t !== "promotion") continue;

      const df = p?.conditions?.start_time || p?.date_from || p?.start_time;
      const dt = p?.conditions?.end_time || p?.date_to || p?.end_time;
      const inWindow =
        (!df || nowMs >= new Date(df).getTime()) &&
        (!dt || nowMs <= new Date(dt).getTime());

      if (!inWindow) continue;

      const percent = pct(p?.regular_amount, p?.amount);
      if (percent !== null && percent > 0) {
        const source = p?.metadata?.campaign_id
          ? "marketplace_campaign"
          : "seller_promotion";
        candidates.push({ percent, source, active: true });
      }
    }

    for (const p of promoNodes) {
      const st = String(p?.status || "").toLowerCase();
      const df = p?.date_from || p?.start_time;
      const dt = p?.date_to || p?.end_time;
      const inWindow =
        (!df || nowMs >= new Date(df).getTime()) &&
        (!dt || nowMs <= new Date(dt).getTime());

      const isActive = (st ? st === "active" : true) && inWindow;
      if (!isActive) continue;

      const percent = pct(
        p?.regular_amount || p?.base_price,
        p?.price || p?.amount
      );
      if (percent !== null && percent > 0) {
        const source = (
          p?.type ||
          p?.campaign_type ||
          p?.origin ||
          "promotion"
        ).toString();
        candidates.push({ percent, source, active: true });
      }
    }

    const anyPrice = (buckets || []).find((x) => x?.amount);
    if (anyPrice && anyPrice?.regular_amount) {
      const percent = pct(anyPrice.regular_amount, anyPrice.amount);
      if (percent !== null && percent > 0) {
        candidates.push({
          percent,
          source: "inferred_from_regular_amount",
          active: true,
        });
      }
    }

    if (candidates.length) {
      candidates.sort((a, b) => (b.percent || 0) - (a.percent || 0));
      const best = candidates[0];
      return { active: true, percent: best.percent, source: best.source };
    }

    return { active: false, percent: null, source: null };
  } catch (e) {
    dbgArr &&
      dbgArr.push({
        type: "promo_error",
        url,
        message: e.message || String(e),
      });
    return { active: false, percent: null, source: null };
  }
}

async function fetchPromosByItems({ token, itemIds, dbgAcc }) {
  const out = {};
  const ids = Array.from(
    new Set((itemIds || []).map((x) => String(x).toUpperCase()).filter(Boolean))
  );
  for (const id of ids) {
    out[id] = await fetchItemPromoNow({
      token,
      itemId: id,
      dbgArr: dbgAcc.calls,
    });
  }
  return out;
}

/** -------------- SUMMARY -------------- */
router.get("/abc-ml/summary", async (req, res) => {
  const p = parseCommonQuery(req.query);
  const { date_from, date_to, full, metric, group_by, a_cut, b_cut } = p;

  if (!date_from || !date_to) {
    return res
      .status(400)
      .json({ error: "date_from e date_to são obrigatórios" });
  }

  try {
    const token = getTokenFromRequest(req, res);
    const sellerId = await getSellerId(token);

    const map = new Map();

    for await (const order of iterOrders({
      token,
      sellerId,
      date_from,
      date_to,
    })) {
      const fullOrder = isFull(order);

      for (const it of order.order_items || []) {
        const mlb = it?.item?.id;
        if (!mlb) continue;

        const sku =
          it?.item?.seller_sku || it?.item?.seller_custom_field || null;
        const q = Number(it?.quantity || 0);
        if (q <= 0) continue;

        if (full === "only" && !fullOrder) continue;
        if (full === "skip" && fullOrder) continue;

        const unitPrice = Number(it?.unit_price || 0);
        const revenue = unitPrice * q;

        const key = makeKey({ mlb, sku }, group_by);
        const row = map.get(key) || {
          mlb,
          sku: group_by === "mlb" ? null : sku,
          title: it?.item?.title,
          logistic_type: order?.shipping?.logistic_type,
          units: 0,
          revenue: 0,
          revenue_cents: 0,
          is_full: false,
        };

        row.units += q;
        row.revenue += revenue;
        row.revenue_cents = Math.round(row.revenue * 100);
        row.is_full = row.is_full || fullOrder;
        map.set(key, row);
      }
    }

    const labeled = classifyABC(Array.from(map.values()), {
      metric: metric === "revenue" ? "revenue" : "units",
      aCut: a_cut,
      bCut: b_cut,
    }).rows;

    const totalUnits = labeled.reduce((s, r) => s + (r.units || 0), 0);
    const totalRevenueCents = labeled.reduce(
      (s, r) => s + (r.revenue_cents || 0),
      0
    );

    function aggCurve(curve) {
      const arr = labeled.filter((r) => r.curve === curve);
      const units = arr.reduce((s, r) => s + (r.units || 0), 0);
      const revenue_cents = arr.reduce((s, r) => s + (r.revenue_cents || 0), 0);
      const items_count = arr.length;
      const ticket_avg_cents =
        units > 0 ? Math.round(revenue_cents / units) : 0;
      const revenue_share =
        totalRevenueCents > 0 ? revenue_cents / totalRevenueCents : 0;
      return {
        units,
        revenue_cents,
        items_count,
        ticket_avg_cents,
        revenue_share,
      };
    }

    const cards = { A: aggCurve("A"), B: aggCurve("B"), C: aggCurve("C") };

    res.json({
      meta: { date_from, date_to, full, metric, group_by, a_cut, b_cut },
      totals: {
        items_total: labeled.length,
        units_total: totalUnits,
        revenue_cents_total: totalRevenueCents,
      },
      curves: {
        A: {
          count_items: labeled.filter((r) => r.curve === "A").length,
          share: cards.A.revenue_share,
        },
        B: {
          count_items: labeled.filter((r) => r.curve === "B").length,
          share: cards.B.revenue_share,
        },
        C: {
          count_items: labeled.filter((r) => r.curve === "C").length,
          share: cards.C.revenue_share,
        },
      },
      curve_cards: {
        A: cards.A,
        B: cards.B,
        C: cards.C,
        TOTAL: {
          units: cards.A.units + cards.B.units + cards.C.units,
          revenue_cents:
            cards.A.revenue_cents +
            cards.B.revenue_cents +
            cards.C.revenue_cents,
          items_count: labeled.length,
          ticket_avg_cents:
            cards.A.units + cards.B.units + cards.C.units > 0
              ? Math.round(
                  (cards.A.revenue_cents +
                    cards.B.revenue_cents +
                    cards.C.revenue_cents) /
                    (cards.A.units + cards.B.units + cards.C.units)
                )
              : 0,
        },
      },
      top5: {
        A: labeled.filter((r) => r.curve === "A").slice(0, 5),
        B: labeled.filter((r) => r.curve === "B").slice(0, 5),
        C: labeled.filter((r) => r.curve === "C").slice(0, 5),
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "abc-ml summary failed", detail: e.message });
  }
});

/** -------------- ITEMS -------------- */
router.get("/abc-ml/items", async (req, res) => {
  const p = parseCommonQuery(req.query);
  const { date_from, date_to, full, metric, group_by, a_cut, b_cut } = p;

  const {
    curve = "ALL",
    search = "",
    sort = "units_desc",
    page = "1",
    limit = "50",
    include_ads: include_ads_raw = "1",
    include_ads_debug: include_ads_debug_raw = "0",
    ads_channels = "marketplace",
    include_promos: include_promos_raw = "1",
    include_promos_debug: include_promos_debug_raw = "0",
    include_visits: include_visits_raw = "0",
    include_visits_debug: include_visits_debug_raw = "0",
  } = req.query;

  const includeAds = parseBoolParam(include_ads_raw, true);
  const includeAdsDebug = parseBoolParam(include_ads_debug_raw, false);
  const includePromos = parseBoolParam(include_promos_raw, true);
  const includePromosDebug = parseBoolParam(include_promos_debug_raw, false);
  const includeVisits = parseBoolParam(include_visits_raw, false);
  const includeVisitsDebug = parseBoolParam(include_visits_debug_raw, false);

  if (!date_from || !date_to) {
    return res
      .status(400)
      .json({ error: "date_from e date_to são obrigatórios" });
  }

  try {
    const token = getTokenFromRequest(req, res);
    const sellerId = await getSellerId(token);

    const map = new Map();

    const from90 = ymdShift(date_to, -89);
    const fetchFrom = ymdMin(date_from, from90);

    // 1) pedidos/agregação base
    for await (const order of iterOrders({
      token,
      sellerId,
      date_from: fetchFrom,
      date_to,
    })) {
      const fullOrder = isFull(order);
      const createdIso = order?.date_created || "";
      const diffDays = daysDiffFromAnchorUTC(date_to, createdIso);
      const inPeriod = inRangeUTC(createdIso, date_from, date_to);

      for (const it of order.order_items || []) {
        const mlb = it?.item?.id;
        if (!mlb) continue;

        const sku =
          it?.item?.seller_sku || it?.item?.seller_custom_field || null;
        const q = Number(it?.quantity || 0);
        if (q <= 0) continue;

        if (full === "only" && !fullOrder) continue;
        if (full === "skip" && fullOrder) continue;

        const unitPrice = Number(it?.unit_price || 0);
        const revenue = unitPrice * q;

        const key = makeKey({ mlb, sku }, group_by);
        const row = map.get(key) || {
          mlb,
          sku: group_by === "mlb" ? null : sku,
          title: it?.item?.title,
          logistic_type: order?.shipping?.logistic_type,
          units: 0,
          revenue: 0,
          revenue_cents: 0,
          is_full: false,

          units_7d: 0,
          units_15d: 0,
          units_30d: 0,
          units_40d: 0,
          units_60d: 0,
          units_90d: 0,

          visits_total: 0,
          visits: 0,
        };

        if (inPeriod) {
          row.units += q;
          row.revenue += revenue;
          row.revenue_cents = Math.round(row.revenue * 100);
          row.is_full = row.is_full || fullOrder;
        }

        if (Number.isFinite(diffDays) && diffDays >= 0) {
          if (diffDays <= 6) row.units_7d += q;
          if (diffDays <= 14) row.units_15d += q;
          if (diffDays <= 29) row.units_30d += q;
          if (diffDays <= 39) row.units_40d += q;
          if (diffDays <= 59) row.units_60d += q;
          if (diffDays <= 89) row.units_90d += q;
        }

        map.set(key, row);
      }
    }

    let rows = Array.from(map.values());

    // 2) classificação ABC + shares
    const labeled = classifyABC(rows, {
      metric: metric === "revenue" ? "revenue" : "units",
      aCut: a_cut,
      bCut: b_cut,
    }).rows;

    const totalUnits = labeled.reduce((s, r) => s + (r.units || 0), 0);
    const totalRevenueCents = labeled.reduce(
      (s, r) => s + (r.revenue_cents || 0),
      0
    );

    labeled.forEach((r) => {
      r.unit_share = totalUnits > 0 ? r.units / totalUnits : 0;
      r.revenue_share =
        totalRevenueCents > 0 ? r.revenue_cents / totalRevenueCents : 0;
    });

    // 3) filtro + ordem
    const filtered = labeled.filter(
      (r) =>
        (curve === "ALL" || r.curve === curve) &&
        (!search ||
          r.mlb?.toString().includes(search) ||
          (r.sku ? r.sku.toString().includes(search) : false) ||
          (r.title || "").toLowerCase().includes(search.toLowerCase()))
    );

    if (sort === "revenue_desc")
      filtered.sort((a, b) => (b.revenue_cents || 0) - (a.revenue_cents || 0));
    else if (sort === "share")
      filtered.sort((a, b) => (b.revenue_share || 0) - (a.revenue_share || 0));
    else filtered.sort((a, b) => (b.units || 0) - (a.units || 0));

    // 4) paginação
    const pnum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const start = (pnum - 1) * lim;
    const pageSlice = filtered.slice(start, start + lim);

    // 5) ADS (itens da página)
    const adsDebug = {};
    const channels = String(ads_channels || "marketplace")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    if (includeAds && pageSlice.length) {
      const dbgAcc = {
        advertisers: {},
        calls: [],
        missingAfterSearch: [],
        missingAfterSingle: [],
      };
      const mlbIds = pageSlice
        .map((r) => String(r.mlb || "").toUpperCase())
        .filter(Boolean);

      const adsAccum = await fetchAdsMetricsByItems({
        req,
        token,
        itemIds: mlbIds,
        date_from,
        date_to,
        channels,
        dbgAcc,
      });

      if (includeAdsDebug) adsDebug.single = dbgAcc;

      for (const it of pageSlice) {
        const key = String(it.mlb || "").toUpperCase();
        const met = adsAccum[key] || null;
        it.ads = met
          ? met
          : {
              status_code: "none",
              status_text: "Não",
              in_campaign: false,
              had_activity: false,
              clicks: 0,
              impressions: 0,
              spend_cents: 0,
              revenue_cents: 0,
              acos: null,
            };
      }
    }

    // 6) PROMOS /prices (snapshot)
    const promosPricesDebug = { calls: [] };
    let pricesPromosAccum = {};
    if (pageSlice.length) {
      const mlbIds = pageSlice
        .map((r) => String(r.mlb || "").toUpperCase())
        .filter(Boolean);
      pricesPromosAccum = await fetchPromosByItems({
        token,
        itemIds: mlbIds,
        dbgAcc: promosPricesDebug,
      });
    }

    // 7) aplica promo no item (sem Central aqui — mantém seu snapshot)
    for (const it of pageSlice) {
      const key = String(it.mlb || "").toUpperCase();
      const fromPrices = pricesPromosAccum[key] || {
        active: false,
        percent: null,
        source: null,
      };
      it.promo = {
        active: !!fromPrices.active,
        percent: fromPrices.percent != null ? Number(fromPrices.percent) : null,
        source: fromPrices.source || null,
      };
    }

    // 8) VISITS
    const visitsDebug = {};
    if (includeVisits && pageSlice.length) {
      const mlbIds = pageSlice
        .map((r) => String(r.mlb || "").toUpperCase())
        .filter(Boolean);
      const dbgArr = [];
      const visitsAccum = await fetchVisitsForItems({
        token,
        itemIds: mlbIds,
        date_from,
        date_to,
        dbgArr,
      });
      if (includeVisitsDebug) visitsDebug.single = dbgArr;

      for (const it of pageSlice) {
        const key = String(it.mlb || "").toUpperCase();
        const v = visitsAccum[key];
        const totalVisits = v ? Number(v.visits_total || 0) : 0;
        it.visits_total = totalVisits;
        it.visits = totalVisits;
      }
    }

    const response = {
      page: pnum,
      limit: lim,
      total: filtered.length,
      data: pageSlice,
    };

    if (includeAdsDebug) response.ads_debug = adsDebug;
    if (includePromosDebug)
      response.promos_debug = { prices_probe: promosPricesDebug };
    if (includeVisitsDebug) response.visits_debug = visitsDebug;

    res.json(response);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "abc-ml items failed", detail: e.message });
  }
});

module.exports = router;
