"use strict";

const { randomUUID } = require("crypto");
const db = require("../db/db");
const TokenService = require("./tokenService");
const { decryptToken } = require("./tokenCrypto");
const { prepareAuthState, listActiveSellerItemIds, consultPrazoItemRow } = require("./prazoProducaoService");
const AdsService = require("./adsService");
const CompanyAccessService = require("./companyAccessService");
const CompanyIntegrationsService = require("./companyIntegrationsService");
const XLSX = require("xlsx");

const _fetch = typeof fetch !== "undefined" ? fetch : require("node-fetch");
const fetchRef = (...args) => _fetch(...args);
const ML_API = "https://api.mercadolibre.com";
const DEFAULT_WINDOW_DAYS = 7;
const WATCHLIST_MAX_RANGE_DAYS = 180;
const MAX_LOOKUP_ITEMS = 5000;
const DEFAULT_TASK_SECTORS = [
  { key: "marketing", label: "Marketing" },
  { key: "cadastro", label: "Cadastro" },
];
const STRATEGIC_ACTIONS = [
  { key: "task.create", group: "Permissoes gerais", label: "Criar tarefa", type: "capability", field: "create_task", icon: "+" },
  { key: "watchlist", group: "Permissoes gerais", label: "Watchlist", type: "module", field: "watchlist", icon: "W" },
  { key: "material.photos", group: "Materiais criados", label: "Fotos novas", type: "material", field: "photos", icon: "▧" },
  { key: "material.clips_video", group: "Materiais criados", label: "Clips/videos novos", type: "material", field: "clips_video", icon: "▶" },
  { key: "listing.photos", group: "Alteracoes no anuncio", label: "Fotos publicadas", type: "listing", field: "photos", icon: "▧" },
  { key: "listing.clips_video", group: "Alteracoes no anuncio", label: "Clips/videos publicados", type: "listing", field: "clips_video", icon: "▶" },
  { key: "listing.title", group: "Alteracoes no anuncio", label: "Titulo", type: "listing", field: "title", icon: "A" },
  { key: "listing.description", group: "Alteracoes no anuncio", label: "Descricao", type: "listing", field: "description", icon: "▤" },
  { key: "listing.attributes", group: "Alteracoes no anuncio", label: "Ficha tecnica", type: "listing", field: "attributes", icon: "≡" },
  { key: "listing.model", group: "Alteracoes no anuncio", label: "Modelo", type: "listing", field: "model", icon: "M" },
  { key: "listing.lead_time", group: "Alteracoes no anuncio", label: "Prazo de producao", type: "listing", field: "lead_time", icon: "◷" },
  { key: "listing.price", group: "Alteracoes no anuncio", label: "Preco", type: "listing", field: "price", icon: "$" },
  { key: "listing.stock", group: "Alteracoes no anuncio", label: "Estoque", type: "listing", field: "stock", icon: "E" },
  { key: "listing.promotion", group: "Alteracoes no anuncio", label: "Promocao", type: "listing", field: "promotion", icon: "◇" },
  { key: "listing.ads", group: "Alteracoes no anuncio", label: "Ads", type: "listing", field: "ads", icon: "↗" },
  { key: "listing.shipping", group: "Alteracoes no anuncio", label: "Frete", type: "listing", field: "shipping", icon: "▣" },
  { key: "listing.other", group: "Alteracoes no anuncio", label: "Outro ajuste", type: "listing", field: "other", icon: "..." },
];
const DEFAULT_STRATEGIC_PERMISSION_SECTORS = {
  "task.create": ["marketing", "cadastro"],
  watchlist: ["marketing", "cadastro"],
  "material.photos": ["marketing"],
  "material.clips_video": ["marketing"],
  "listing.photos": ["cadastro"],
  "listing.clips_video": ["cadastro"],
  "listing.title": ["cadastro"],
  "listing.description": ["cadastro"],
  "listing.attributes": ["cadastro"],
  "listing.model": ["cadastro"],
  "listing.stock": ["cadastro"],
  "listing.other": ["cadastro"],
  "listing.lead_time": ["logistica"],
  "listing.shipping": ["logistica"],
  "listing.price": ["comercial"],
  "listing.promotion": ["comercial"],
  "listing.ads": ["ads"],
};
const TAG_COLOR_PRESETS = {
  blue: "#3b82f6",
  indigo: "#6366f1",
  violet: "#8b5cf6",
  cyan: "#06b6d4",
  green: "#22c55e",
  amber: "#f59e0b",
  orange: "#f97316",
  red: "#ef4444",
  rose: "#f43f5e",
  slate: "#64748b",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeAccountKey = (value) => String(value || "").trim() || "default";
const toInt = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : fallback;
};
const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
function normMlb(value) {
  const text = String(value || "").trim().toUpperCase();
  return /^MLB\d{6,}$/.test(text) ? text : null;
}
function uniq(list) {
  return Array.from(new Set((Array.isArray(list) ? list : []).filter(Boolean)));
}
function parseTokens(input) {
  return String(input || "").split(/[\s,;\n\r\t]+/).map((item) => item.trim()).filter(Boolean);
}
function ymd(date = new Date()) {
  return date.toISOString().slice(0, 10);
}
function currentDateSaoPaulo(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
function toYmd(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return ymd(value);
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? ymd(parsed) : null;
}
function addDays(ymdValue, days) {
  const d = new Date(`${ymdValue}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Math.trunc(Number(days) || 0));
  return ymd(d);
}
function diffDays(fromYmd, toYmdValue) {
  const a = new Date(`${fromYmd}T00:00:00.000Z`).getTime();
  const b = new Date(`${toYmdValue}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 86400000) + 1;
}
function validYmd(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}
function pickDateOr(value, fallback) {
  const next = toYmd(value);
  return validYmd(next) ? next : fallback;
}
function resolveWatchlistDateRange({ mode = "first_action", from = null, to = null, firstActionOn = null, lastActionOn = null, createdOn = null } = {}) {
  const cleanMode = String(mode || "first_action").trim().toLowerCase();
  const today = currentDateSaoPaulo();
  const fallbackStart = pickDateOr(firstActionOn, pickDateOr(createdOn, addDays(today, -29)));
  const fallbackLast = pickDateOr(lastActionOn, fallbackStart);
  let fromDate = fallbackStart;
  let toDate = today;
  if (cleanMode === "last_action") {
    fromDate = fallbackLast;
  } else if (cleanMode === "custom") {
    fromDate = pickDateOr(from, fallbackStart);
    toDate = pickDateOr(to, today);
  }
  if (!validYmd(fromDate)) fromDate = addDays(today, -29);
  if (!validYmd(toDate)) toDate = today;
  if (toDate < fromDate) [fromDate, toDate] = [toDate, fromDate];
  const rawDays = diffDays(fromDate, toDate);
  let wasClamped = false;
  if (rawDays > WATCHLIST_MAX_RANGE_DAYS) {
    fromDate = addDays(toDate, -(WATCHLIST_MAX_RANGE_DAYS - 1));
    wasClamped = true;
  }
  const days = diffDays(fromDate, toDate);
  const previousTo = addDays(fromDate, -1);
  const previousFrom = addDays(previousTo, -(days - 1));
  return {
    mode: cleanMode === "last_action" ? "last_action" : cleanMode === "custom" ? "custom" : "first_action",
    from: fromDate,
    to: toDate,
    days,
    previous_from: previousFrom,
    previous_to: previousTo,
    was_clamped: wasClamped,
    max_days: WATCHLIST_MAX_RANGE_DAYS,
  };
}
function sumMetric(rows = [], key) {
  return rows.reduce((sum, row) => {
    const value = Number(row?.[key]);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
}
function averageMetric(rows = [], key) {
  let total = 0;
  let count = 0;
  for (const row of rows) {
    const value = Number(row?.[key]);
    if (!Number.isFinite(value)) continue;
    total += value;
    count += 1;
  }
  return count ? total / count : null;
}
function buildWatchlistRoundAggregate(rounds = []) {
  const safeRows = Array.isArray(rounds) ? rounds : [];
  const impressions = sumMetric(safeRows, "impressions");
  const clicks = sumMetric(safeRows, "clicks");
  const visits = sumMetric(safeRows, "visits");
  const sales = sumMetric(safeRows, "sales");
  const revenue = sumMetric(safeRows, "revenue");
  const conversionAvg = averageMetric(safeRows, "conversion");
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : null;
  const conversion = conversionAvg != null
    ? Number(conversionAvg.toFixed(4))
    : visits > 0
      ? Number(((sales / visits) * 100).toFixed(4))
      : null;
  return {
    impressions: Number(impressions || 0),
    clicks: Number(clicks || 0),
    ctr: ctr == null ? null : Number(ctr.toFixed(4)),
    visits: Number(visits || 0),
    sales: Number(sales || 0),
    revenue: Number(revenue.toFixed(2)),
    conversion,
  };
}
function buildLeadTimeSnapshotFromPrazoRow(prazoRow = null) {
  if (!prazoRow || prazoRow.success !== true || !prazoRow.prazo) return null;
  const rawDays = Number(prazoRow.prazo.days);
  const hasPrazo = prazoRow.prazo.has_prazo === true;
  const days = Number.isFinite(rawDays) ? Math.trunc(rawDays) : hasPrazo ? 0 : 0;
  const label = prazoRow.prazo.value_name
    || (days > 0 ? `${days} dias` : "Sem prazo");
  return {
    has_prazo: hasPrazo,
    days,
    value_name: label,
    unit: prazoRow.prazo.unit || "dias",
    last_updated: prazoRow.last_updated || null,
    captured_at: new Date().toISOString(),
    source: "ml_prazo_endpoint",
  };
}
function leadTimeSnapshotDays(snapshot = null) {
  const raw = Number(snapshot?.days);
  return Number.isFinite(raw) ? Math.trunc(raw) : 0;
}
function leadTimeSnapshotLabel(snapshot = null) {
  if (!snapshot) return "Sem prazo (0 dia)";
  const valueName = String(snapshot.value_name || "").trim();
  if (valueName) return valueName;
  const days = leadTimeSnapshotDays(snapshot);
  return days > 0 ? `${days} dias` : "Sem prazo (0 dia)";
}
function leadTimeSnapshotChanged(previous = null, current = null) {
  if (!current) return false;
  if (!previous) return true;
  if (leadTimeSnapshotDays(previous) !== leadTimeSnapshotDays(current)) return true;
  return Boolean(previous?.has_prazo) !== Boolean(current?.has_prazo);
}
function findLatestLeadTimeSnapshot(events = [], fallback = null) {
  for (const event of Array.isArray(events) ? events : []) {
    const snapshot = event?.payload?.lead_time_snapshot;
    if (snapshot && typeof snapshot === "object") return snapshot;
  }
  const baseSnapshot = fallback?.lead_time_snapshot;
  return baseSnapshot && typeof baseSnapshot === "object" ? baseSnapshot : null;
}
const startOfDay = (value) => `${value}T00:00:00.000-00:00`;
const endOfDay = (value) => `${value}T23:59:59.999-00:00`;
function clampWindowDays(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(3, Math.min(30, Math.trunc(n))) : DEFAULT_WINDOW_DAYS;
}
function extractSkuFromItem(item = {}) {
  const skuAttr = Array.isArray(item?.attributes) ? item.attributes.find((attr) => String(attr?.id || "").toUpperCase() === "SELLER_SKU") : null;
  const variationSku = Array.isArray(item?.variations) ? item.variations.map((v) => v?.seller_custom_field || v?.seller_sku).find(Boolean) : null;
  const value = item?.seller_custom_field || item?.seller_sku || variationSku || skuAttr?.value_name || null;
  return value ? String(value).trim() : null;
}
async function renewAuthState(state) {
  const renewed = await TokenService.renovarToken(state.creds || {});
  const token = renewed?.access_token || state.token;
  if (!token) return false;
  state.token = token;
  state.creds.access_token = token;
  if (renewed?.refresh_token) state.creds.refresh_token = renewed.refresh_token;
  if (renewed?.expires_in) state.creds.access_expires_at = new Date(Date.now() + Number(renewed.expires_in) * 1000).toISOString();
  return true;
}
async function authFetch(state, pathOrUrl, init = {}) {
  const url = /^https?:\/\//i.test(String(pathOrUrl || "")) ? String(pathOrUrl) : `${ML_API}${pathOrUrl}`;
  const call = (token) => fetchRef(url, { ...init, headers: { Accept: "application/json", ...(init.headers || {}), Authorization: `Bearer ${token}` } });
  let response = await call(state.token);
  if (response.status !== 401) return response;
  return (await renewAuthState(state)) ? call(state.token) : response;
}
async function mlJson(state, pathOrUrl, init = {}, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await authFetch(state, pathOrUrl, init);
    const body = await response.json().catch(() => ({}));
    if (response.ok) return body;
    lastError = new Error(body?.message || body?.error || `Mercado Livre HTTP ${response.status}`);
    lastError.statusCode = response.status;
    lastError.details = body;
    if ((response.status === 429 || response.status >= 500) && attempt < attempts) {
      await sleep(400 * attempt);
      continue;
    }
    break;
  }
  throw lastError || new Error("Falha ao consultar Mercado Livre.");
}
async function getSellerId(state, mlCreds = {}) {
  const fromCreds = mlCreds?.meli_user_id || mlCreds?.user_id || state?.creds?.meli_user_id || state?.creds?.user_id;
  if (fromCreds) return String(fromCreds);
  const me = await mlJson(state, "/users/me", {}, 2);
  if (!me?.id) throw new Error("Nao foi possivel identificar o seller_id da conta.");
  return String(me.id);
}
async function fetchItemDetails(state, ids = []) {
  const result = [];
  const uniqueIds = uniq(ids.map(normMlb));
  const attrs = [
    "id",
    "title",
    "status",
    "available_quantity",
    "seller_custom_field",
    "seller_sku",
    "price",
    "thumbnail",
    "secure_thumbnail",
    "permalink",
    "seller_id",
    "variations",
    "attributes",
    "listing_type_id",
    "catalog_listing",
    "shipping",
    "tags",
    "video_id",
  ].join(",");
  for (let i = 0; i < uniqueIds.length; i += 20) {
    const chunk = uniqueIds.slice(i, i + 20);
    const data = await mlJson(state, `/items?ids=${encodeURIComponent(chunk.join(","))}&attributes=${encodeURIComponent(attrs)}`, {}, 3);
    for (const entry of Array.isArray(data) ? data : []) {
      const body = entry?.body || entry;
      if (body?.id) result.push(body);
    }
  }
  return result;
}
async function resolveRequestedItems({ state, mlCreds, query }) {
  const tokens = parseTokens(query);
  const mlbs = uniq(tokens.map(normMlb));
  const skus = uniq(tokens.filter((token) => !normMlb(token)).map((token) => token.toUpperCase()));
  if (!mlbs.length && !skus.length) throw new Error("Informe ao menos um MLB ou SKU para buscar.");
  let sellerId = await getSellerId(state, mlCreds);
  let skuMatchedIds = [];
  if (skus.length) {
    const listing = await listActiveSellerItemIds({ authState: state, mlCreds, maxItems: MAX_LOOKUP_ITEMS });
    sellerId = listing?.sellerId || sellerId;
    const details = await fetchItemDetails(state, listing.ids || []);
    skuMatchedIds = details.filter((item) => skus.includes(String(extractSkuFromItem(item) || "").toUpperCase())).map((item) => normMlb(item.id));
  }
  const ids = uniq([...mlbs, ...skuMatchedIds]);
  if (!ids.length) throw new Error("Nenhum anuncio ativo encontrado para os MLBs/SKUs informados.");
  return { ids, sellerId };
}
function normalizeItemPayload(item, { sellerId = null, accountKey = null, accountLabel = null } = {}) {
  return {
    account_key: accountKey || null,
    account_label: accountLabel || null,
    seller_id: item?.seller_id ? String(item.seller_id) : sellerId ? String(sellerId) : null,
    mlb: normMlb(item?.id || item?.mlb),
    sku: extractSkuFromItem(item) || item?.sku || null,
    title: item?.title || "",
    thumbnail: item?.secure_thumbnail || item?.thumbnail || null,
    permalink: item?.permalink || null,
    status: item?.status || null,
    price: Number.isFinite(Number(item?.price)) ? Number(item.price) : null,
    stock: Number.isFinite(Number(item?.available_quantity ?? item?.stock)) ? Math.trunc(Number(item.available_quantity ?? item.stock)) : null,
  };
}
function hasVideoTag(item = {}) {
  const tags = Array.isArray(item?.tags) ? item.tags : [];
  return tags.some((tag) => String(tag || "").toLowerCase().includes("video"));
}
function isFulfillmentItem(item = {}) {
  const logisticType = String(item?.shipping?.logistic_type || "").toLowerCase();
  if (logisticType === "fulfillment") return true;
  const tags = Array.isArray(item?.tags) ? item.tags : [];
  return tags.some((tag) => String(tag || "").toLowerCase().includes("fulfillment"));
}
function normalizeListingBadges(badges = {}) {
  return {
    full: !!badges.full,
    free_shipping: !!badges.free_shipping,
    catalog: !!badges.catalog,
    promo: !!badges.promo,
    ads: !!badges.ads,
    clips: !!badges.clips,
  };
}
function listingBadgesFromItem(item = {}, { promo = false, ads = false } = {}) {
  return normalizeListingBadges({
    full: isFulfillmentItem(item),
    free_shipping: Boolean(item?.shipping?.free_shipping),
    catalog: Boolean(item?.catalog_listing),
    promo: !!promo,
    ads: !!ads,
    clips: Boolean(item?.video_id) || hasVideoTag(item),
  });
}
function promotionActiveFromPricesPayload(payload = {}) {
  const buckets = [];
  if (Array.isArray(payload?.prices?.prices)) buckets.push(...payload.prices.prices);
  if (Array.isArray(payload?.prices)) buckets.push(...payload.prices);
  if (Array.isArray(payload?.promotions)) buckets.push(...payload.promotions);
  const now = Date.now();
  return buckets.some((price) => {
    const type = String(price?.type || price?.status || "").toLowerCase();
    const from = price?.conditions?.start_time || price?.date_from || price?.start_time;
    const to = price?.conditions?.end_time || price?.date_to || price?.end_time;
    const inWindow = (!from || now >= new Date(from).getTime()) && (!to || now <= new Date(to).getTime());
    const regular = Number(price?.regular_amount || 0);
    const amount = Number(price?.amount || price?.price || 0);
    return inWindow && (
      type.includes("promotion")
      || type === "active"
      || (regular > 0 && amount > 0 && regular > amount)
    );
  });
}
async function fetchPromoMapForItems(state, ids = []) {
  const out = new Map(ids.map((id) => [id, false]));
  for (const id of ids) {
    try {
      const payload = await mlJson(state, `/items/${encodeURIComponent(id)}/prices`, {}, 2);
      out.set(id, promotionActiveFromPricesPayload(payload));
    } catch (_error) {
      out.set(id, false);
    }
  }
  return out;
}
async function fetchAdsMapForItems(state, ids = [], range = {}) {
  const out = new Map(ids.map((id) => [id, false]));
  if (!ids.length) return out;
  try {
    const metricsByItem = await AdsService.metricsPorItens({
      mlbIds: ids,
      date_from: range.from,
      date_to: range.to,
      access_token: state.token,
    });
    for (const id of ids) {
      const row = metricsByItem?.[id] || metricsByItem?.[String(id).toUpperCase()] || null;
      if (!row) {
        out.set(id, false);
        continue;
      }
      const impressions = Number(row.impressions || 0);
      const clicks = Number(row.clicks || 0);
      const cost = Number(
        row.cost
        ?? row.spend
        ?? row.investment
        ?? row.investimento
        ?? row.total_cost
        ?? 0,
      );
      const active = String(row.status || "").toLowerCase() === "active"
        || impressions > 0
        || clicks > 0
        || cost > 0;
      out.set(id, !!active);
    }
  } catch (_error) {
    // Se Ads estiver indisponível para a conta, mantemos as badges desligadas.
  }
  return out;
}
async function lookupItems({ accessToken, mlCreds = {}, accountKey, accountLabel, query }) {
  const state = await prepareAuthState({ accessToken, mlCreds });
  const resolved = await resolveRequestedItems({ state, mlCreds, query });
  const details = await fetchItemDetails(state, resolved.ids);
  const rows = details.map((item) => normalizeItemPayload(item, { sellerId: resolved.sellerId, accountKey, accountLabel }));
  return { success: true, total: rows.length, rows };
}
async function fetchVisits({ state, mlb, from, to }) {
  const attempts = [
    () => mlJson(state, `/items/${encodeURIComponent(mlb)}/visits?date_from=${encodeURIComponent(from)}&date_to=${encodeURIComponent(to)}`, {}, 2),
    () => mlJson(state, `/visits/items?ids=${encodeURIComponent(mlb)}&date_from=${encodeURIComponent(from)}&date_to=${encodeURIComponent(to)}`, {}, 2),
    () => mlJson(state, `/items/${encodeURIComponent(mlb)}/visits`, {}, 2),
  ];
  for (const fn of attempts) {
    try {
      const payload = await fn();
      if (typeof payload?.total_visits === "number") return payload.total_visits;
      if (payload && typeof payload === "object" && payload[mlb] != null) {
        const row = payload[mlb];
        if (typeof row === "number") return row;
        if (typeof row?.total_visits === "number") return row.total_visits;
      }
      if (Array.isArray(payload)) {
        const row = payload.find((entry) => entry?.id === mlb || entry?.item_id === mlb);
        const value = row?.total_visits ?? row?.visits ?? row?.total;
        if (Number.isFinite(Number(value))) return Number(value);
      }
    } catch (_error) {}
  }
  return null;
}
async function fetchOrdersMetrics({ state, sellerId, mlb, from, to }) {
  let offset = 0;
  const limit = 50;
  let total = 0;
  const metrics = { sales: 0, orders: 0, revenue: 0, first_order_at: null, last_order_at: null };
  for (;;) {
    const url = new URL(`${ML_API}/orders/search`);
    url.searchParams.set("seller", sellerId);
    url.searchParams.set("item", mlb);
    url.searchParams.set("order.status", "paid");
    url.searchParams.set("order.date_created.from", startOfDay(from));
    url.searchParams.set("order.date_created.to", endOfDay(to));
    url.searchParams.set("sort", "date_desc");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    const payload = await mlJson(state, url.toString(), {}, 4);
    const batch = Array.isArray(payload?.results) ? payload.results : [];
    total = toInt(payload?.paging?.total, total);
    for (const order of batch) {
      let orderHasItem = false;
      const date = order?.date_created || order?.date_closed || null;
      for (const orderItem of Array.isArray(order?.order_items) ? order.order_items : []) {
        if (normMlb(orderItem?.item?.id) !== mlb) continue;
        const qty = toInt(orderItem?.quantity, 0);
        const unitPrice = toNumber(orderItem?.unit_price, 0);
        metrics.sales += qty;
        metrics.revenue += qty * unitPrice;
        orderHasItem = true;
      }
      if (orderHasItem) {
        metrics.orders += 1;
        if (date && (!metrics.first_order_at || String(date) < String(metrics.first_order_at))) metrics.first_order_at = date;
        if (date && (!metrics.last_order_at || String(date) > String(metrics.last_order_at))) metrics.last_order_at = date;
      }
    }
    offset += batch.length;
    if (!batch.length || (total && offset >= total) || offset >= 10000) break;
  }
  metrics.revenue = Number(metrics.revenue.toFixed(2));
  return metrics;
}
async function fetchAdsMetrics({ state, mlb, from, to }) {
  try {
    const metricsByItem = await AdsService.metricsPorItens({
      mlbIds: [mlb],
      date_from: from,
      date_to: to,
      access_token: state.token,
    });
    const row = metricsByItem?.[mlb] || metricsByItem?.[String(mlb).toUpperCase()] || null;
    if (!row) return { impressions: null, clicks: null, ctr: null };
    const impressions = Number.isFinite(Number(row.impressions)) ? toInt(row.impressions, 0) : null;
    const clicks = Number.isFinite(Number(row.clicks)) ? toInt(row.clicks, 0) : null;
    const ctr = impressions && impressions > 0 && clicks != null ? Number(((clicks / impressions) * 100).toFixed(4)) : null;
    return { impressions, clicks, ctr };
  } catch (error) {
    console.warn("[Estrategicos] Falha ao coletar metricas de ads:", error?.message || error);
    return { impressions: null, clicks: null, ctr: null };
  }
}
function emptyMetrics(from = null, to = null) {
  return { from, to, days: 0, impressions: null, clicks: null, ctr: null, visits: null, sales: 0, orders: 0, revenue: 0, conversion: null };
}
async function captureMetrics({ state, sellerId, mlb, from, to }) {
  if (!from || !to || diffDays(from, to) <= 0) return emptyMetrics(from, to);
  const [orders, visits, ads] = await Promise.all([
    fetchOrdersMetrics({ state, sellerId, mlb, from, to }),
    fetchVisits({ state, mlb, from, to }),
    fetchAdsMetrics({ state, mlb, from, to }),
  ]);
  const conversion = visits && visits > 0 ? (orders.sales / visits) * 100 : null;
  return {
    from,
    to,
    days: diffDays(from, to),
    impressions: ads.impressions,
    clicks: ads.clicks,
    ctr: ads.ctr,
    visits: visits == null ? null : toInt(visits, 0),
    sales: orders.sales,
    orders: orders.orders,
    revenue: orders.revenue,
    conversion: conversion == null ? null : Number(conversion.toFixed(4)),
    first_order_at: orders.first_order_at,
    last_order_at: orders.last_order_at,
  };
}
function numericDelta(after, before) {
  const a = Number(after);
  const b = Number(before);
  return Number.isFinite(a) && Number.isFinite(b) ? Number((a - b).toFixed(4)) : null;
}
function percentDelta(after, before) {
  const a = Number(after);
  const b = Number(before);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (b === 0) return a > 0 ? 100 : 0;
  return Number((((a - b) / b) * 100).toFixed(2));
}
function buildDeltas(beforeMetrics = {}, afterMetrics = {}) {
  return {
    impressions: { before: beforeMetrics.impressions, after: afterMetrics.impressions, delta: numericDelta(afterMetrics.impressions, beforeMetrics.impressions), pct: percentDelta(afterMetrics.impressions, beforeMetrics.impressions) },
    clicks: { before: beforeMetrics.clicks, after: afterMetrics.clicks, delta: numericDelta(afterMetrics.clicks, beforeMetrics.clicks), pct: percentDelta(afterMetrics.clicks, beforeMetrics.clicks) },
    ctr: { before: beforeMetrics.ctr, after: afterMetrics.ctr, delta: numericDelta(afterMetrics.ctr, beforeMetrics.ctr), pct: percentDelta(afterMetrics.ctr, beforeMetrics.ctr) },
    visits: { before: beforeMetrics.visits, after: afterMetrics.visits, delta: numericDelta(afterMetrics.visits, beforeMetrics.visits), pct: percentDelta(afterMetrics.visits, beforeMetrics.visits) },
    sales: { before: beforeMetrics.sales || 0, after: afterMetrics.sales || 0, delta: numericDelta(afterMetrics.sales || 0, beforeMetrics.sales || 0), pct: percentDelta(afterMetrics.sales || 0, beforeMetrics.sales || 0) },
    conversion: { before: beforeMetrics.conversion, after: afterMetrics.conversion, delta: numericDelta(afterMetrics.conversion, beforeMetrics.conversion), pct: percentDelta(afterMetrics.conversion, beforeMetrics.conversion) },
    revenue: { before: beforeMetrics.revenue || 0, after: afterMetrics.revenue || 0, delta: numericDelta(afterMetrics.revenue || 0, beforeMetrics.revenue || 0), pct: percentDelta(afterMetrics.revenue || 0, beforeMetrics.revenue || 0) },
  };
}
function classifyComparison(beforeMetrics = {}, afterMetrics = {}, afterComplete = true) {
  if (!afterComplete) return { impact: "inconclusive", confidence: "low" };
  const beforeSales = toInt(beforeMetrics.sales, 0);
  const afterSales = toInt(afterMetrics.sales, 0);
  const beforeVisits = beforeMetrics.visits == null ? null : toInt(beforeMetrics.visits, 0);
  const afterVisits = afterMetrics.visits == null ? null : toInt(afterMetrics.visits, 0);
  const beforeConv = beforeMetrics.conversion == null ? null : Number(beforeMetrics.conversion);
  const afterConv = afterMetrics.conversion == null ? null : Number(afterMetrics.conversion);
  const beforeRevenue = toNumber(beforeMetrics.revenue, 0);
  const afterRevenue = toNumber(afterMetrics.revenue, 0);
  const salesPct = percentDelta(afterSales, beforeSales);
  const revenuePct = percentDelta(afterRevenue, beforeRevenue);
  const convDelta = beforeConv != null && afterConv != null ? afterConv - beforeConv : null;
  const sample = beforeSales + afterSales + toInt(beforeVisits, 0) + toInt(afterVisits, 0);
  const confidence = sample >= 150 || beforeSales + afterSales >= 12 ? "high" : sample >= 40 || beforeSales + afterSales >= 4 ? "medium" : "low";
  if (beforeSales + afterSales === 0 && (!beforeVisits || !afterVisits)) return { impact: "inconclusive", confidence: "low" };
  if ((salesPct != null && salesPct >= 15) || (revenuePct != null && revenuePct >= 15) || (convDelta != null && convDelta >= 0.5)) return { impact: "improved", confidence };
  if ((salesPct != null && salesPct <= -15) || (revenuePct != null && revenuePct <= -15) || (convDelta != null && convDelta <= -0.5)) return { impact: "worse", confidence };
  return { impact: "stable", confidence };
}
function buildRoundInsights(round) {
  const deltas = round.deltas || {};
  const insights = [];
  if (round.impact === "improved") insights.push({ type: "positive", title: "Alteracao com sinal positivo", text: "O recorte depois da alteracao melhorou em vendas, receita ou conversao." });
  else if (round.impact === "worse") insights.push({ type: "danger", title: "Alteracao merece revisao", text: "O desempenho caiu no recorte comparado. Vale revisar o que mudou antes de repetir em outros anuncios." });
  else if (round.impact === "stable") insights.push({ type: "neutral", title: "Resultado estavel", text: "A mudanca nao gerou diferenca relevante dentro da janela analisada." });
  else insights.push({ type: "warning", title: "Amostra inconclusiva", text: "Ainda nao ha volume suficiente ou janela completa para cravar impacto." });
  if (Number.isFinite(Number(deltas?.visits?.pct)) && deltas.visits.pct >= 20 && !(Number.isFinite(Number(deltas?.sales?.pct)) && deltas.sales.pct >= 10)) insights.push({ type: "warning", title: "Visitas subiram sem acompanhar vendas", text: "A vitrine atraiu mais trafego, mas a conversao ainda precisa ser observada." });
  if (Number.isFinite(Number(deltas?.conversion?.delta)) && deltas.conversion.delta > 0) insights.push({ type: "positive", title: "Conversao melhorou", text: `Conversao subiu ${Math.abs(deltas.conversion.delta).toFixed(2)} ponto(s) percentuais.` });
  if (Number.isFinite(Number(deltas?.revenue?.pct)) && deltas.revenue.pct < -15) insights.push({ type: "danger", title: "Receita caiu", text: "Mesmo que outra metrica tenha melhorado, a receita do periodo perdeu forca." });
  return insights.slice(0, 4);
}
async function upsertItem(client, item) {
  const { rows } = await client.query(
    `insert into ml_strategic_items
      (account_key, account_label, seller_id, mlb, sku, title, thumbnail, permalink, status, price, stock, last_seen_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now())
     on conflict (account_key, mlb)
     do update set account_label = excluded.account_label, seller_id = coalesce(excluded.seller_id, ml_strategic_items.seller_id), sku = coalesce(excluded.sku, ml_strategic_items.sku), title = coalesce(excluded.title, ml_strategic_items.title), thumbnail = coalesce(excluded.thumbnail, ml_strategic_items.thumbnail), permalink = coalesce(excluded.permalink, ml_strategic_items.permalink), status = excluded.status, price = excluded.price, stock = excluded.stock, last_seen_at = now(), updated_at = now()
     returning *`,
    [item.account_key, item.account_label, item.seller_id, item.mlb, item.sku, item.title, item.thumbnail, item.permalink, item.status, item.price, item.stock],
  );
  return rows[0];
}
function normalizeChangeFlags(flags = {}) {
  const allowed = ["photo", "title", "price", "description", "attributes", "model", "clips", "lead_time", "shipping", "stock", "promotion", "ads", "other"];
  return allowed.reduce((acc, key) => ({ ...acc, [key]: !!flags?.[key] }), {});
}
const MATERIAL_KEYS = ["photos", "clips_video"];
const LISTING_CHANGE_KEYS = ["photos", "clips_video", "title", "description", "attributes", "model", "lead_time", "price", "stock", "promotion", "ads", "shipping", "other"];
function sectorKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}
function sectorLabelFromKey(value) {
  const key = sectorKey(value);
  return DEFAULT_TASK_SECTORS.find((item) => item.key === key)?.label
    || key.split(/[_-]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ")
    || "Setor";
}
async function listTaskSectorOptions({ empresaId = null } = {}) {
  try {
    const rows = await CompanyAccessService.listCompanySectors(Number(empresaId) || null);
    const byKey = new Map(DEFAULT_TASK_SECTORS.map((item) => [item.key, item]));
    for (const row of rows || []) {
      const key = sectorKey(row.key || row.setor);
      if (!key) continue;
      byKey.set(key, { key, label: String(row.label || "").trim() || sectorLabelFromKey(key) });
    }
    return [...byKey.values()];
  } catch (_error) {
    return DEFAULT_TASK_SECTORS;
  }
}
async function listStrategicIntegrationStatus({ empresaId = null } = {}) {
  return CompanyIntegrationsService.listStrategicIntegrationStatus({ empresaId });
}
async function trelloRequest({ empresaId = null, path = "", params = {} } = {}) {
  const integration = await CompanyIntegrationsService.getActiveProviderCredentials({ empresaId, provider: "trello" });
  const { api_key: apiKey, access_token: token } = integration.credentials || {};
  if (!apiKey || !token) {
    const error = new Error("Chave e token do Trello precisam estar configurados em Conta > Integracoes.");
    error.statusCode = 400;
    throw error;
  }
  const url = new URL(`${integration.api_base_url}${String(path || "").startsWith("/") ? path : `/${path}`}`);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("token", token);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  const response = await fetchRef(url.toString(), { method: "GET", headers: { Accept: "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.message || body?.error || `Trello respondeu HTTP ${response.status}.`);
    error.statusCode = response.status;
    throw error;
  }
  return body;
}
function normalizeTrelloId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
}
function extractTrelloIdentifiers(card = {}) {
  const checklistText = (Array.isArray(card.checklists) ? card.checklists : [])
    .flatMap((checklist) => [checklist?.name, ...(Array.isArray(checklist?.checkItems) ? checklist.checkItems.map((item) => item?.name) : [])])
    .join("\n");
  const text = [card.name, card.desc, checklistText].map((value) => String(value || "")).join("\n");
  const mlbs = uniq((text.match(/MLB\d{6,}/gi) || []).map((item) => item.toUpperCase()));
  const skuCandidates = [];
  const skuPatterns = [
    /\bSKU\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{1,60})/gi,
    /\bREF\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{1,60})/gi,
  ];
  for (const pattern of skuPatterns) {
    for (const match of text.matchAll(pattern)) {
      const value = String(match?.[1] || "").trim().toUpperCase();
      if (value && !/^MLB\d+$/i.test(value)) skuCandidates.push(value);
    }
  }
  return { mlbs, skus: uniq(skuCandidates) };
}
function mapTrelloBoard(row = {}) {
  return {
    id: String(row.id || ""),
    name: String(row.name || "Board sem nome"),
    url: row.url || row.shortUrl || null,
    closed: row.closed === true,
    updated_at: row.dateLastActivity || null,
  };
}
function mapTrelloList(row = {}) {
  return {
    id: String(row.id || ""),
    board_id: String(row.idBoard || ""),
    name: String(row.name || "Lista sem nome"),
    closed: row.closed === true,
    pos: Number(row.pos || 0),
  };
}
function mapTrelloCard(row = {}, listMap = new Map()) {
  const identifiers = extractTrelloIdentifiers(row);
  const listId = String(row.idList || "");
  return {
    id: String(row.id || ""),
    list_id: listId,
    list_name: listMap.get(listId)?.name || "",
    name: String(row.name || "Card sem titulo"),
    desc: String(row.desc || ""),
    url: row.url || row.shortUrl || null,
    due: row.due || null,
    due_complete: row.dueComplete === true,
    closed: row.closed === true,
    mlbs: identifiers.mlbs,
    skus: identifiers.skus,
    tokens: uniq([...identifiers.mlbs, ...identifiers.skus]),
    matched: identifiers.mlbs.length > 0 || identifiers.skus.length > 0,
  };
}
async function attachTrelloChecklists({ empresaId = null, cards = [] } = {}) {
  const output = [];
  for (const card of cards) {
    let enriched = card;
    try {
      const checklists = await trelloRequest({
        empresaId,
        path: `/cards/${encodeURIComponent(card.id)}/checklists`,
        params: { fields: "name", checkItem_fields: "name,state" },
      });
      enriched = { ...card, checklists: Array.isArray(checklists) ? checklists : [] };
    } catch (_error) {
      enriched = { ...card, checklists: [] };
    }
    output.push(mapTrelloCard(enriched, new Map([[card.list_id, { name: card.list_name }]])));
  }
  return output;
}
async function listTrelloBoards({ empresaId = null, actor = {} } = {}) {
  await assertStrategicActionPermission({ empresaId, actor, actionKey: "task.create", mode: "edit", message: "Seu setor nao possui permissao para importar tarefas do Trello." });
  const rows = await trelloRequest({
    empresaId,
    path: "/members/me/boards",
    params: { filter: "open", fields: "name,url,shortUrl,closed,dateLastActivity" },
  });
  return { success: true, boards: (Array.isArray(rows) ? rows : []).map(mapTrelloBoard).filter((row) => row.id && !row.closed) };
}
async function listTrelloBoardLists({ empresaId = null, actor = {}, boardId = "" } = {}) {
  await assertStrategicActionPermission({ empresaId, actor, actionKey: "task.create", mode: "edit", message: "Seu setor nao possui permissao para importar tarefas do Trello." });
  const id = normalizeTrelloId(boardId);
  if (!id) throw new Error("Board do Trello invalido.");
  const rows = await trelloRequest({
    empresaId,
    path: `/boards/${encodeURIComponent(id)}/lists`,
    params: { filter: "open", fields: "name,closed,pos,idBoard" },
  });
  return { success: true, lists: (Array.isArray(rows) ? rows : []).map(mapTrelloList).filter((row) => row.id && !row.closed) };
}
async function previewTrelloCards({ empresaId = null, actor = {}, boardId = "", listIds = [], filter = "open" } = {}) {
  await assertStrategicActionPermission({ empresaId, actor, actionKey: "task.create", mode: "edit", message: "Seu setor nao possui permissao para importar tarefas do Trello." });
  const id = normalizeTrelloId(boardId);
  if (!id) throw new Error("Board do Trello invalido.");
  const cleanLists = uniq((Array.isArray(listIds) ? listIds : []).map(normalizeTrelloId).filter(Boolean));
  if (!cleanLists.length) throw new Error("Selecione ao menos uma lista do Trello.");
  const listsPayload = await listTrelloBoardLists({ empresaId, actor, boardId: id });
  const listMap = new Map((listsPayload.lists || []).map((item) => [item.id, item]));
  const cards = [];
  for (const listId of cleanLists) {
    const rows = await trelloRequest({
      empresaId,
      path: `/lists/${encodeURIComponent(listId)}/cards`,
      params: {
        filter: filter === "all" ? "all" : "open",
        fields: "id,idList,name,desc,url,shortUrl,due,dueComplete,closed,dateLastActivity",
      },
    });
    const mapped = (Array.isArray(rows) ? rows : []).map((row) => mapTrelloCard(row, listMap));
    cards.push(...(await attachTrelloChecklists({ empresaId, cards: mapped })));
  }
  const matched = cards.filter((card) => card.matched).length;
  return { success: true, total: cards.length, matched, cards };
}
function emptyStrategicPermissionMatrix(sectors = []) {
  const sectorKeys = (Array.isArray(sectors) ? sectors : []).map((item) => sectorKey(item.key || item.setor)).filter(Boolean);
  const matrix = {};
  for (const action of STRATEGIC_ACTIONS) {
    matrix[action.key] = {};
    for (const setor of sectorKeys) {
      const defaultEdit = (DEFAULT_STRATEGIC_PERMISSION_SECTORS[action.key] || []).includes(setor);
      const defaultView = action.key === "watchlist" ? true : defaultEdit;
      matrix[action.key][setor] = { can_view: defaultView, can_edit: defaultEdit };
    }
  }
  return matrix;
}
async function listStrategicPermissions({ empresaId = null } = {}) {
  const id = Number(empresaId);
  const sectors = await listTaskSectorOptions({ empresaId });
  const matrix = emptyStrategicPermissionMatrix(sectors);
  if (Number.isFinite(id) && id > 0) {
    const { rows } = await db.query(
      `select setor, action_key, pode_visualizar, pode_editar
         from empresa_estrategicos_permissoes
        where empresa_id = $1`,
      [id],
    );
    for (const row of rows) {
      const action = String(row.action_key || "").trim();
      const setor = sectorKey(row.setor);
      if (!matrix[action] || !matrix[action][setor]) continue;
      matrix[action][setor] = {
        can_view: row.pode_visualizar === true,
        can_edit: row.pode_editar === true,
      };
    }
  }
  return { success: true, sectors, actions: STRATEGIC_ACTIONS, permissions: matrix };
}
async function saveStrategicPermissions({ empresaId = null, permissions = {}, userId = null } = {}) {
  const id = Number(empresaId);
  if (!Number.isFinite(id) || id <= 0) throw Object.assign(new Error("Empresa nao encontrada para salvar permissoes."), { statusCode: 400 });
  const sectors = await listTaskSectorOptions({ empresaId: id });
  const sectorSet = new Set(sectors.map((item) => sectorKey(item.key || item.setor)).filter(Boolean));
  const actionSet = new Set(STRATEGIC_ACTIONS.map((item) => item.key));
  const rows = [];
  for (const [actionKey, sectorMap] of Object.entries(permissions || {})) {
    if (!actionSet.has(actionKey) || !sectorMap || typeof sectorMap !== "object") continue;
    for (const [rawSetor, value] of Object.entries(sectorMap)) {
      const setor = sectorKey(rawSetor);
      if (!sectorSet.has(setor)) continue;
      const canEdit = value?.can_edit === true || value?.pode_editar === true;
      const canView = canEdit || value?.can_view === true || value?.pode_visualizar === true;
      rows.push({ actionKey, setor, canView, canEdit });
    }
  }
  await db.withClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("delete from empresa_estrategicos_permissoes where empresa_id = $1", [id]);
      for (const row of rows) {
        await client.query(
          `insert into empresa_estrategicos_permissoes
             (empresa_id, setor, action_key, pode_visualizar, pode_editar, atualizado_por, atualizado_em)
           values ($1,$2,$3,$4,$5,$6,now())`,
          [id, row.setor, row.actionKey, row.canView, row.canEdit, Number(userId) || null],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
  return listStrategicPermissions({ empresaId: id });
}
async function getStrategicPermissionMatrix(empresaId = null) {
  return (await listStrategicPermissions({ empresaId })).permissions;
}
function actionEditSectors(matrix = {}, actionKey = "") {
  const configured = matrix?.[actionKey] || {};
  const sectors = Object.entries(configured).filter(([, value]) => value?.can_edit === true).map(([setor]) => sectorKey(setor)).filter(Boolean);
  return sectors.length ? sectors : (DEFAULT_STRATEGIC_PERMISSION_SECTORS[actionKey] || []);
}
function actionViewSectors(matrix = {}, actionKey = "") {
  const configured = matrix?.[actionKey] || {};
  const sectors = Object.entries(configured)
    .filter(([, value]) => value?.can_view === true || value?.can_edit === true)
    .map(([setor]) => sectorKey(setor))
    .filter(Boolean);
  if (sectors.length) return sectors;
  return actionEditSectors(matrix, actionKey);
}
async function actorCanUseStrategicAction({ empresaId = null, actor = {}, actionKey = "", mode = "edit" } = {}) {
  const normalized = normalizeActor(actor);
  if (normalized.isAdmin) return true;
  if (!actionKey) return false;
  const matrix = await getStrategicPermissionMatrix(empresaId);
  const allowed = mode === "view" ? actionViewSectors(matrix, actionKey) : actionEditSectors(matrix, actionKey);
  return allowed.some((setor) => normalized.sectors.includes(setor));
}
async function assertStrategicActionPermission({ empresaId = null, actor = {}, actionKey = "", mode = "edit", message = "" } = {}) {
  if (await actorCanUseStrategicAction({ empresaId, actor, actionKey, mode })) return;
  const error = new Error(message || "Seu setor nao possui permissao para executar esta acao.");
  error.statusCode = 403;
  throw error;
}
function actionKeysFromFlags(flags = {}) {
  const actions = [];
  if (flags.photo) actions.push("material.photos", "listing.photos");
  if (flags.clips) actions.push("material.clips_video", "listing.clips_video");
  if (flags.title) actions.push("listing.title");
  if (flags.description) actions.push("listing.description");
  if (flags.attributes) actions.push("listing.attributes");
  if (flags.model) actions.push("listing.model");
  if (flags.lead_time) actions.push("listing.lead_time");
  if (flags.price) actions.push("listing.price");
  if (flags.stock) actions.push("listing.stock");
  if (flags.promotion) actions.push("listing.promotion");
  if (flags.ads) actions.push("listing.ads");
  if (flags.shipping) actions.push("listing.shipping");
  if (flags.other) actions.push("listing.other");
  return uniq(actions);
}
function executionActionKeys(materials = {}, changes = {}) {
  const actions = [];
  for (const key of MATERIAL_KEYS) if (materials?.[key]) actions.push(`material.${key}`);
  for (const key of LISTING_CHANGE_KEYS) if (changes?.[key]) actions.push(`listing.${key}`);
  return uniq(actions);
}
function actorEditSectorsForActions(actor = {}, actions = [], matrix = {}) {
  const normalizedActor = normalizeActor(actor);
  const touched = new Set();
  for (const action of actions) {
    const allowed = actionEditSectors(matrix, action);
    const usable = normalizedActor.isAdmin ? allowed : allowed.filter((setor) => normalizedActor.sectors.includes(setor));
    if (!usable.length) {
      const error = new Error("Seu setor nao possui permissao para registrar uma ou mais alteracoes selecionadas.");
      error.statusCode = 403;
      throw error;
    }
    usable.forEach((setor) => touched.add(setor));
  }
  return [...touched];
}
function inferTaskSectorsFromFlags(flags = {}, permissionMatrix = null) {
  const sectors = new Set();
  const matrix = permissionMatrix || emptyStrategicPermissionMatrix(DEFAULT_TASK_SECTORS);
  for (const action of actionKeysFromFlags(flags)) {
    actionEditSectors(matrix, action).forEach((setor) => sectors.add(setor));
  }
  if (!sectors.size) sectors.add("cadastro");
  return [...sectors];
}
async function normalizeTaskSectors({ empresaId = null, sectors = [], flags = {}, fallback = [] } = {}) {
  const options = await listTaskSectorOptions({ empresaId });
  const optionMap = new Map(options.map((item) => [item.key, item.label]));
  const requested = Array.isArray(sectors) ? sectors : [];
  const fallbackKeys = Array.isArray(fallback) ? fallback.map((item) => item.key || item.setor || item).filter(Boolean) : [];
  const matrix = await getStrategicPermissionMatrix(empresaId);
  const source = requested.length ? requested : fallbackKeys.length ? fallbackKeys : inferTaskSectorsFromFlags(flags, matrix);
  const normalized = [];
  const seen = new Set();
  for (const raw of source) {
    const key = sectorKey(raw?.key || raw?.setor || raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push({ key, label: optionMap.get(key) || String(raw?.label || "").trim() || sectorLabelFromKey(key) });
  }
  return normalized.length ? normalized : [{ key: "cadastro", label: optionMap.get("cadastro") || "Cadastro" }];
}
function normalizeSectorRows(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    return typeof value === "string" ? JSON.parse(value) : [];
  } catch (_error) {
    return [];
  }
}
function normalizeCancelReason(value) {
  return String(value || "").trim().slice(0, 500);
}
function normalizeActor(actor = {}) {
  return {
    isAdmin: actor?.isAdmin === true,
    sectors: uniq((Array.isArray(actor?.sectors) ? actor.sectors : []).map((item) => sectorKey(item?.key || item?.setor || item)).filter(Boolean)),
  };
}
function assertActorCanUseSectors(actor = {}, sectorKeys = [], message = "Seu usuario nao possui setor liberado para executar esta acao.") {
  const normalizedActor = normalizeActor(actor);
  if (normalizedActor.isAdmin) return;
  const keys = uniq((Array.isArray(sectorKeys) ? sectorKeys : []).map(sectorKey).filter(Boolean));
  if (!normalizedActor.sectors.length) {
    const error = new Error("Seu usuario ainda nao possui setor atribuido. Peça para um administrador configurar seu setor para assumir ou editar tarefas.");
    error.statusCode = 403;
    throw error;
  }
  const blocked = keys.filter((key) => !normalizedActor.sectors.includes(key));
  if (blocked.length) {
    const error = new Error(message);
    error.statusCode = 403;
    throw error;
  }
}
function normalizeBoolMap(source = {}, allowed = []) {
  return allowed.reduce((acc, key) => ({ ...acc, [key]: !!source?.[key] }), {});
}
function normalizeExecutionPayload(payload = {}) {
  const base = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  return { ...base, entries: Array.isArray(base.entries) ? base.entries : [] };
}
function normalizeMaterialLocations(source = {}) {
  return MATERIAL_KEYS.reduce((acc, key) => {
    const value = String(source?.[key] || "").trim();
    if (value) acc[key] = value.slice(0, 500);
    return acc;
  }, {});
}
function mergeLatestMaterialLocations(entries = [], next = {}) {
  const merged = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const locations = normalizeMaterialLocations(entry?.material_locations || {});
    for (const [key, value] of Object.entries(locations)) merged[key] = value;
  }
  const incoming = normalizeMaterialLocations(next || {});
  for (const [key, value] of Object.entries(incoming)) merged[key] = value;
  return merged;
}
function hasAnyTrue(source = {}) {
  return Object.values(source || {}).some(Boolean);
}
function listingChangesToLegacyFlags(changes = {}) {
  return normalizeChangeFlags({
    photo: !!changes.photos,
    clips: !!changes.clips_video,
    title: !!changes.title,
    description: !!changes.description,
    attributes: !!changes.attributes,
    model: !!changes.model,
    lead_time: !!changes.lead_time,
    price: !!changes.price,
    stock: !!changes.stock,
    promotion: !!changes.promotion,
    ads: !!changes.ads,
    shipping: !!changes.shipping,
    other: !!changes.other,
  });
}
function listingChangesFromLegacyFlags(flags = {}) {
  const normalized = normalizeChangeFlags(flags);
  return normalizeBoolMap({
    photos: !!normalized.photo,
    clips_video: !!normalized.clips,
    title: !!normalized.title,
    description: !!normalized.description,
    attributes: !!normalized.attributes,
    model: !!normalized.model,
    lead_time: !!normalized.lead_time,
    price: !!normalized.price,
    stock: !!normalized.stock,
    promotion: !!normalized.promotion,
    ads: !!normalized.ads,
    shipping: !!normalized.shipping,
    other: !!normalized.other,
  }, LISTING_CHANGE_KEYS);
}
function sectorKeysForExecution(materials = {}, changes = {}, permissionMatrix = {}, actor = {}) {
  return actorEditSectorsForActions(actor, executionActionKeys(materials, changes), permissionMatrix);
}
function actionKeyForRequirement(kind, key) {
  return kind === "material" ? `material.${key}` : `listing.${key}`;
}
function taskSectorKeys(task = {}) {
  return uniq(
    normalizeSectorRows(task.sectors)
      .map((sector) => sectorKey(sector?.key || sector?.setor || sector))
      .filter(Boolean),
  );
}
function taskRequirementIsApplicable(task = {}, kind = "listing", key = "", permissionMatrix = {}) {
  const sectors = taskSectorKeys(task);
  if (!sectors.length) return true;
  const action = actionKeyForRequirement(kind, key);
  const editableBy = actionEditSectors(permissionMatrix, action);
  if (!editableBy.length) return true;
  return editableBy.some((sector) => sectors.includes(sector));
}
function sectorHasMissingWork(sector, completion = {}, permissionMatrix = {}) {
  const key = sectorKey(sector);
  const missingActions = [
    ...(completion.missingMaterials || []).map((item) => actionKeyForRequirement("material", item)),
    ...(completion.missingListings || []).map((item) => actionKeyForRequirement("listing", item)),
  ];
  return missingActions.some((action) => actionEditSectors(permissionMatrix, action).includes(key));
}
const REQUIRED_MATERIAL_BY_FLAG = { photo: "photos", clips: "clips_video" };
const REQUIRED_LISTING_BY_FLAG = {
  photo: "photos",
  clips: "clips_video",
  title: "title",
  description: "description",
  attributes: "attributes",
  model: "model",
  lead_time: "lead_time",
  price: "price",
  stock: "stock",
  promotion: "promotion",
  ads: "ads",
  shipping: "shipping",
  other: "other",
};
const REQUIREMENT_LABELS = {
  photos: "Fotos",
  clips_video: "Clips/videos",
  title: "Titulo",
  description: "Descricao",
  attributes: "Ficha tecnica",
  model: "Modelo",
  lead_time: "Prazo de producao",
  price: "Preco",
  stock: "Estoque",
  promotion: "Promocao",
  ads: "Ads",
  shipping: "Frete",
  other: "Outro ajuste",
};
function progressStateFromEntries(entries = [], extraMaterials = {}, extraChanges = {}, extraNotApplicable = {}) {
  const materialDone = {};
  const listingDone = {};
  const materialNotApplicable = {};
  const listingNotApplicable = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const reopenFlags = normalizeChangeFlags(entry?.reopen_flags || {});
    if (hasAnyTrue(reopenFlags)) {
      const reopenedListings = listingChangesFromLegacyFlags(reopenFlags);
      for (const key of LISTING_CHANGE_KEYS) {
        if (reopenedListings[key]) listingDone[key] = false;
      }
    }
    for (const key of MATERIAL_KEYS) {
      if (entry?.materials_unset?.[key]) materialDone[key] = false;
      if (entry?.materials_not_applicable_unset?.[key]) materialNotApplicable[key] = false;
      if (entry?.materials_created?.[key]) {
        materialDone[key] = true;
        materialNotApplicable[key] = false;
      }
      if (entry?.materials_not_applicable?.[key]) {
        materialDone[key] = false;
        materialNotApplicable[key] = true;
      }
    }
    for (const key of LISTING_CHANGE_KEYS) {
      if (entry?.listing_unset?.[key]) listingDone[key] = false;
      if (entry?.listing_not_applicable_unset?.[key]) listingNotApplicable[key] = false;
      if (entry?.listing_changes?.[key]) {
        listingDone[key] = true;
        listingNotApplicable[key] = false;
      }
      if (entry?.listing_not_applicable?.[key]) {
        listingDone[key] = false;
        listingNotApplicable[key] = true;
      }
    }
  }
  for (const key of MATERIAL_KEYS) if (extraMaterials?.[key]) {
    materialDone[key] = true;
    materialNotApplicable[key] = false;
  }
  for (const key of LISTING_CHANGE_KEYS) if (extraChanges?.[key]) {
    listingDone[key] = true;
    listingNotApplicable[key] = false;
  }
  for (const key of MATERIAL_KEYS) if (extraNotApplicable?.materials?.[key]) {
    materialDone[key] = false;
    materialNotApplicable[key] = true;
  }
  for (const key of LISTING_CHANGE_KEYS) if (extraNotApplicable?.listings?.[key]) {
    listingDone[key] = false;
    listingNotApplicable[key] = true;
  }
  return { materialDone, listingDone, materialNotApplicable, listingNotApplicable };
}
function taskCompletionState(task = {}, extraMaterials = {}, extraChanges = {}, options = {}) {
  const permissionMatrix = options?.permissionMatrix || {};
  const payload = normalizeExecutionPayload(task.execution_payload);
  const flags = normalizeChangeFlags(task.task_flags || {});
  const { materialDone, listingDone, materialNotApplicable, listingNotApplicable } = progressStateFromEntries(
    payload.entries,
    extraMaterials,
    extraChanges,
    options?.notApplicable || {},
  );
  const requestedMaterials = Object.entries(REQUIRED_MATERIAL_BY_FLAG)
    .filter(([flag, key]) => flags[flag] && taskRequirementIsApplicable(task, "material", key, permissionMatrix))
    .map(([, key]) => key);
  const requestedListings = Object.entries(REQUIRED_LISTING_BY_FLAG)
    .filter(([flag, key]) => flags[flag] && taskRequirementIsApplicable(task, "listing", key, permissionMatrix))
    .map(([, key]) => key);
  const missingMaterials = requestedMaterials.filter((key) => !materialDone[key] && !materialNotApplicable[key]);
  const missingListings = requestedListings.filter((key) => !listingDone[key] && !listingNotApplicable[key]);
  return {
    materialDone,
    listingDone,
    materialNotApplicable,
    listingNotApplicable,
    requestedMaterials,
    requestedListings,
    missingMaterials,
    missingListings,
    complete: !missingMaterials.length && !missingListings.length,
  };
}
function missingTaskWorkMessage(state = {}) {
  const parts = [];
  if (state.missingMaterials?.length) parts.push(`materiais: ${state.missingMaterials.map((key) => REQUIREMENT_LABELS[key] || key).join(", ")}`);
  if (state.missingListings?.length) parts.push(`publicacao no anuncio: ${state.missingListings.map((key) => REQUIREMENT_LABELS[key] || key).join(", ")}`);
  return parts.length ? `Ainda faltam etapas obrigatorias antes de iniciar o monitoramento (${parts.join("; ")}).` : "";
}
function normalizeUserSnapshot(user = {}, userId = null) {
  const id = Number(user?.id ?? userId);
  const email = String(user?.email || "").trim() || null;
  const name = String(user?.name || user?.nome || user?.display_name || "").trim() || email || (Number.isFinite(id) && id > 0 ? `Usuario ${id}` : "Usuario");
  return { id: Number.isFinite(id) && id > 0 ? id : null, name, email };
}
function buildExecutionEntry({ user = {}, userId = null, materialsCreated = {}, listingChanges = {}, materialsUnset = {}, listingUnset = {}, materialsNotApplicable = {}, listingNotApplicable = {}, materialsNotApplicableUnset = {}, listingNotApplicableUnset = {}, materialLocations = {}, notes = "", statusAfter = "in_progress", createsRound = false, roundId = null } = {}) {
  const snapshot = normalizeUserSnapshot(user, userId);
  const materials = normalizeBoolMap(materialsCreated, MATERIAL_KEYS);
  const changes = normalizeBoolMap(listingChanges, LISTING_CHANGE_KEYS);
  const unsetMaterials = normalizeBoolMap(materialsUnset, MATERIAL_KEYS);
  const unsetListings = normalizeBoolMap(listingUnset, LISTING_CHANGE_KEYS);
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    user_id: snapshot.id,
    user_name: snapshot.name,
    user_email: snapshot.email,
    materials_created: materials,
    listing_changes: changes,
    materials_unset: unsetMaterials,
    listing_unset: unsetListings,
    materials_not_applicable: normalizeBoolMap(materialsNotApplicable, MATERIAL_KEYS),
    listing_not_applicable: normalizeBoolMap(listingNotApplicable, LISTING_CHANGE_KEYS),
    materials_not_applicable_unset: normalizeBoolMap(materialsNotApplicableUnset, MATERIAL_KEYS),
    listing_not_applicable_unset: normalizeBoolMap(listingNotApplicableUnset, LISTING_CHANGE_KEYS),
    material_locations: normalizeMaterialLocations(materialLocations),
    notes: String(notes || "").trim().slice(0, 2000),
    status_after: normalizeTaskStatus(statusAfter) || "in_progress",
    creates_round: !!createsRound,
    round_id: roundId ? String(roundId) : null,
  };
}
function buildReopenExecutionEntry({ user = {}, userId = null, reopenFlags = {}, notes = "", roundId = null, reviewId = null } = {}) {
  const snapshot = normalizeUserSnapshot(user, userId);
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "reopened_from_monitoring",
    at: new Date().toISOString(),
    user_id: snapshot.id,
    user_name: snapshot.name,
    user_email: snapshot.email,
    reopen_flags: normalizeChangeFlags(reopenFlags),
    notes: String(notes || "").trim().slice(0, 2000),
    status_after: "returned",
    round_id: roundId ? String(roundId) : null,
    review_id: reviewId ? String(reviewId) : null,
  };
}
function buildMaterialReturnExecutionEntry({ user = {}, userId = null, materials = {}, reason = "", note = "", sync = null } = {}) {
  const snapshot = normalizeUserSnapshot(user, userId);
  const returnedMaterials = normalizeBoolMap(materials, MATERIAL_KEYS);
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "materials_returned",
    at: new Date().toISOString(),
    user_id: snapshot.id,
    user_name: snapshot.name,
    user_email: snapshot.email,
    materials_unset: returnedMaterials,
    materials_returned: returnedMaterials,
    notes: String(note || reason || "").trim().slice(0, 2000),
    reason: String(reason || "").trim().slice(0, 500),
    status_after: "returned",
    integration_sync: sync || null,
  };
}
function normalizeGroupColor(value) {
  const allowed = new Set(["blue", "green", "yellow", "red", "gray", "cyan", "violet"]);
  const color = String(value || "blue").trim().toLowerCase();
  return allowed.has(color) ? color : "blue";
}
function normalizePriority(value) {
  const priority = String(value || "medium").trim().toLowerCase();
  return ["low", "medium", "high"].includes(priority) ? priority : "medium";
}
function normalizeTaskStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return ["pending", "in_progress", "review", "returned", "completed", "canceled"].includes(status) ? status : null;
}
function defaultTaskBatchName(query = "", total = 0) {
  const firstToken = parseTokens(query)[0] || "";
  const hint = firstToken ? ` - ${firstToken}` : "";
  const date = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date()).replace(",", "");
  return `Lote ${date}${hint}${total ? ` (${total} itens)` : ""}`.slice(0, 100);
}
function normalizeBatchStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return ["active", "archived", "canceled"].includes(status) ? status : null;
}
function normalizeTagName(value) {
  const clean = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return clean || null;
}
function normalizeTagColor(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) {
    const hex = raw.length === 4
      ? `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`
      : raw;
    return hex.toLowerCase();
  }
  return TAG_COLOR_PRESETS[raw] || null;
}
function normalizeTaskTagsPayload({ tags = [], tagColors = {} } = {}) {
  const picked = [];
  const fromArray = Array.isArray(tags) ? tags : parseTokens(tags);
  for (const raw of fromArray) {
    if (raw && typeof raw === "object") {
      const name = normalizeTagName(raw.name || raw.label || raw.tag || raw.value);
      if (!name) continue;
      picked.push({ name, color: normalizeTagColor(raw.color) });
      continue;
    }
    const name = normalizeTagName(raw);
    if (name) picked.push({ name, color: null });
  }
  const seen = new Set();
  const normalized = [];
  for (const item of picked) {
    const key = item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(item);
    if (normalized.length >= 12) break;
  }
  const inputColors = tagColors && typeof tagColors === "object" ? tagColors : {};
  const colorMap = {};
  for (const item of normalized) {
    const byExact = normalizeTagColor(inputColors[item.name]);
    const byLower = normalizeTagColor(inputColors[item.name.toLowerCase()]);
    const byEntry = normalizeTagColor(item.color);
    const color = byExact || byLower || byEntry;
    if (color) colorMap[item.name] = color;
  }
  return {
    tags: normalized.map((item) => item.name),
    tagColors: colorMap,
  };
}
function uniqueTaskTags(values = []) {
  const unique = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const name = normalizeTagName(value);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
  }
  return unique;
}
function normalizeTaskTagColorsMap(colors = {}, tags = []) {
  const source = colors && typeof colors === "object" ? colors : {};
  const allowed = new Set(uniqueTaskTags(tags).map((tag) => tag.toLowerCase()));
  const normalized = {};
  for (const [rawKey, rawColor] of Object.entries(source)) {
    const name = normalizeTagName(rawKey);
    if (!name) continue;
    if (allowed.size && !allowed.has(name.toLowerCase())) continue;
    const color = normalizeTagColor(rawColor);
    if (color) normalized[name] = color;
  }
  return normalized;
}
function mapTaskBatchRow(row = {}) {
  const batchTags = uniqueTaskTags(row.tags);
  const batchTagColors = normalizeTaskTagColorsMap(row.tag_colors, batchTags);
  return {
    id: String(row.id),
    account_key: row.account_key,
    name: row.name || "Lote de tarefas",
    status: row.status || "active",
    priority: row.priority || "medium",
    due_date: toYmd(row.due_date),
    analysis_start_date: toYmd(row.analysis_start_date),
    tags: batchTags,
    tag_colors: batchTagColors,
    task_flags: row.task_flags || {},
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    archived_at: row.archived_at || null,
    canceled_at: row.canceled_at || null,
    next_due_date: toYmd(row.next_due_date || row.due_date),
    total: Number(row.total || 0),
    pending: Number(row.pending || 0),
    in_progress: Number(row.in_progress || 0),
    review: Number(row.review || 0),
    returned: Number(row.returned || 0),
    completed: Number(row.completed || 0),
    canceled: Number(row.canceled || 0),
    high: Number(row.high || 0),
    overdue: Number(row.overdue || 0),
    sectors: normalizeSectorRows(row.sectors),
    group: row.group_name ? { id: row.group_id ? String(row.group_id) : null, name: row.group_name, color: row.group_color || "blue" } : null,
    created_by: row.created_by_user_id ? { id: String(row.created_by_user_id), name: row.created_by_nome || row.created_by_email || null, email: row.created_by_email || null } : null,
  };
}
async function getTaskBatch({ accountKey, batchId } = {}) {
  const id = String(batchId || "").trim();
  if (!id) return null;
  const { rows } = await db.query(
    `select b.*, g.name as group_name, g.color as group_color, u.nome as created_by_nome, u.email as created_by_email
       from ml_strategic_task_batches b
       left join ml_strategic_groups g on g.id = b.group_id
       left join usuarios u on u.id = b.created_by_user_id
      where b.id = $1
        and b.account_key = $2
      limit 1`,
    [id, safeAccountKey(accountKey)],
  );
  return rows[0] || null;
}
async function listTaskBatchSectorDefinitions({ accountKey, batchId } = {}) {
  const id = String(batchId || "").trim();
  if (!id) return [];
  const { rows } = await db.query(
    `select s.setor as key, max(s.label) as label
       from ml_strategic_task_sectors s
       join ml_strategic_tasks t on t.id = s.task_id
      where t.account_key = $1
        and t.task_batch_id = $2
      group by s.setor
      order by max(s.label) asc`,
    [safeAccountKey(accountKey), id],
  );
  return rows.map((row) => ({ key: row.key, label: row.label || sectorLabelFromKey(row.key) }));
}
async function listTaskBatchItemTokens({ accountKey, batchId } = {}) {
  const id = String(batchId || "").trim();
  if (!id) return { success: true, items: [], tokens: [] };
  const resolvedAccountKey = safeAccountKey(accountKey);
  const batch = await getTaskBatch({ accountKey: resolvedAccountKey, batchId: id });
  if (!batch) throw new Error("Lote de tarefas nao encontrado.");
  const { rows } = await db.query(
    `select mlb, sku, title_snapshot as title, status
       from ml_strategic_tasks
      where account_key = $1
        and task_batch_id = $2
        and status in ('pending','in_progress','review','returned','completed')
      order by created_at asc, id asc`,
    [resolvedAccountKey, id],
  );
  const items = rows.map((row) => ({
    mlb: row.mlb || "",
    sku: row.sku || "",
    title: row.title || row.mlb || "",
    status: row.status || "",
  }));
  const tokens = uniq(items.flatMap((item) => [item.mlb, item.sku]).map((value) => String(value || "").trim().toUpperCase()).filter(Boolean));
  return { success: true, items, tokens };
}
async function insertTaskSectors(client, taskId, sectors = [], status = "pending") {
  const id = Number(taskId);
  if (!Number.isFinite(id) || id <= 0) return;
  for (const sector of sectors) {
    const key = sectorKey(sector.key || sector.setor);
    if (!key) continue;
    await client.query(
      `insert into ml_strategic_task_sectors (task_id, setor, label, status, updated_at)
       values ($1,$2,$3,$4,now())
       on conflict (task_id, setor) do update set
         label = excluded.label,
         updated_at = now()`,
      [id, key, String(sector.label || "").trim() || sectorLabelFromKey(key), status],
    );
  }
}
async function markTaskSectors({ client = db, taskId, sectors = [], status = "completed", userId = null, action = "sector_completed", note = "", payload = {} } = {}) {
  const id = Number(taskId);
  const normalized = uniq((Array.isArray(sectors) ? sectors : []).map(sectorKey));
  if (!Number.isFinite(id) || id <= 0 || !normalized.length) return 0;
  const { rows } = await client.query(
    `update ml_strategic_task_sectors
        set status = $3,
            assigned_user_id = coalesce(assigned_user_id, $4),
            assigned_at = case when assigned_user_id is null and $4::bigint is not null then now() else assigned_at end,
            completed_at = case when $3 = 'completed' then coalesce(completed_at, now()) else completed_at end,
            updated_at = now()
      where task_id = $1
        and setor = any($2::text[])
        and status <> 'canceled'
      returning task_id, setor`,
    [id, normalized, status, Number(userId) || null],
  );
  for (const row of rows) {
    await client.query(
      `insert into ml_strategic_task_sector_events (task_id, setor, user_id, action, note, payload)
       values ($1,$2,$3,$4,$5,$6::jsonb)`,
      [row.task_id, row.setor, Number(userId) || null, action, String(note || "").trim() || null, JSON.stringify(payload || {})],
    );
  }
  return rows.length;
}
async function syncTaskStatusFromSectors(client, taskId, preferredStatus = null) {
  const id = Number(taskId);
  if (!Number.isFinite(id) || id <= 0) return;
  const { rows } = await client.query(
    `select
       count(*)::int as total,
       count(*) filter (where status = 'completed')::int as completed,
       count(*) filter (where status = 'review')::int as review,
       count(*) filter (where status = 'in_progress')::int as in_progress,
       count(*) filter (where status = 'returned')::int as returned
     from ml_strategic_task_sectors
    where task_id = $1`,
    [id],
  );
  const row = rows[0] || {};
  let next = preferredStatus;
  if (Number(row.total || 0) > 0 && Number(row.completed || 0) >= Number(row.total || 0)) next = preferredStatus === "completed" ? "completed" : "review";
  else if (Number(row.returned || 0) > 0) next = "returned";
  else if (Number(row.review || 0) > 0) next = "review";
  else if (Number(row.in_progress || 0) > 0) next = "in_progress";
  if (!next) return;
  await client.query(
    `update ml_strategic_tasks
        set status = $2,
            started_at = case when $2 in ('in_progress','review') then coalesce(started_at, now()) else started_at end,
            updated_at = now()
      where id = $1
        and status not in ('completed','canceled')`,
    [id, next],
  );
}
function mapGroupRow(row = {}) {
  return {
    id: String(row.id),
    account_key: row.account_key,
    name: row.name,
    color: row.color || "blue",
    is_active: row.is_active !== false,
    sort_order: Number(row.sort_order || 0),
    usage_count: Number(row.usage_count || 0),
  };
}
async function listGroups({ accountKey } = {}) {
  const { rows } = await db.query(
    `select g.*,
            count(r.id)::int as usage_count
       from ml_strategic_groups g
       left join ml_strategic_rounds r on r.group_id = g.id
      where g.account_key = $1
        and g.is_active = true
      group by g.id
      order by g.sort_order asc, lower(g.name) asc`,
    [safeAccountKey(accountKey)],
  );
  return { success: true, groups: rows.map(mapGroupRow) };
}
async function createGroup({ accountKey, name, color = "blue" } = {}) {
  const cleanName = String(name || "").trim();
  if (!cleanName) throw new Error("Informe o nome do grupo.");
  if (cleanName.length > 60) throw new Error("Nome do grupo deve ter ate 60 caracteres.");
  const { rows } = await db.query(
    `insert into ml_strategic_groups (account_key, name, color, is_active, updated_at)
     values ($1, $2, $3, true, now())
     on conflict (account_key, lower(name))
     do update set name = excluded.name, color = excluded.color, is_active = true, updated_at = now()
     returning *`,
    [safeAccountKey(accountKey), cleanName, normalizeGroupColor(color)],
  );
  return { success: true, group: mapGroupRow(rows[0]) };
}
async function updateGroup({ accountKey, groupId, name, color, isActive = true } = {}) {
  const id = Number(groupId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Grupo invalido.");
  const cleanName = String(name || "").trim();
  if (!cleanName) throw new Error("Informe o nome do grupo.");
  const { rows } = await db.query(
    `update ml_strategic_groups
        set name = $3,
            color = $4,
            is_active = $5,
            updated_at = now()
      where id = $1
        and account_key = $2
      returning *`,
    [id, safeAccountKey(accountKey), cleanName, normalizeGroupColor(color), isActive !== false],
  );
  if (!rows.length) throw new Error("Grupo nao encontrado.");
  return { success: true, group: mapGroupRow(rows[0]) };
}
async function resolveGroupId({ accountKey, groupId } = {}) {
  const id = Number(groupId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const { rows } = await db.query(
    `select id from ml_strategic_groups where id = $1 and account_key = $2 and is_active = true limit 1`,
    [id, safeAccountKey(accountKey)],
  );
  if (!rows.length) throw new Error("Grupo estrategico nao encontrado para esta conta.");
  return Number(rows[0].id);
}
function rangesForAlteration(alterationDate, windowDays) {
  const date = toYmd(alterationDate) || currentDateSaoPaulo();
  const days = clampWindowDays(windowDays);
  const beforeTo = addDays(date, -1);
  const beforeFrom = addDays(beforeTo, -(days - 1));
  const afterFrom = date;
  const afterTo = addDays(afterFrom, days - 1);
  const reviewDue = addDays(afterFrom, days);
  return { alterationDate: date, windowDays: days, beforeFrom, beforeTo, afterFrom, afterTo, reviewDue };
}
async function createRounds({ accessToken, mlCreds = {}, accountKey, accountLabel, items = [], query = "", groupId = null, sourceTaskId = null, taskBatchId = null, taskBatchName = null, changeFlags = {}, changeNotes = "", alterationDate = null, windowDays = DEFAULT_WINDOW_DAYS }) {
  const resolvedAccountKey = safeAccountKey(accountKey || mlCreds?.meli_conta_id || mlCreds?.id || mlCreds?.meli_user_id);
  const resolvedGroupId = await resolveGroupId({ accountKey: resolvedAccountKey, groupId });
  const state = await prepareAuthState({ accessToken, mlCreds });
  const sellerId = await getSellerId(state, mlCreds);
  let normalizedItems = Array.isArray(items) ? items.filter((item) => normMlb(item?.mlb || item?.id)) : [];
  if (!normalizedItems.length) {
    const lookup = await lookupItems({ accessToken, mlCreds, accountKey: resolvedAccountKey, accountLabel, query });
    normalizedItems = lookup.rows;
  }
  if (!normalizedItems.length) throw new Error("Nenhum anuncio selecionado para monitorar.");
  const ids = uniq(normalizedItems.map((item) => normMlb(item.mlb || item.id)));
  const details = await fetchItemDetails(state, ids);
  const detailMap = new Map(details.map((item) => [normMlb(item.id), item]));
  const ranges = rangesForAlteration(alterationDate, windowDays);
  const flags = normalizeChangeFlags(changeFlags);
  const created = [];
  await db.withClient(async (client) => {
    await client.query("begin");
    try {
      for (const raw of normalizedItems) {
        const mlb = normMlb(raw.mlb || raw.id);
        const itemPayload = normalizeItemPayload(detailMap.get(mlb) || raw, { sellerId, accountKey: resolvedAccountKey, accountLabel });
        itemPayload.mlb = mlb;
        itemPayload.account_key = resolvedAccountKey;
        itemPayload.account_label = accountLabel || raw.account_label || null;
        itemPayload.seller_id = itemPayload.seller_id || sellerId;
        const storedItem = await upsertItem(client, itemPayload);
        if (resolvedGroupId) {
          await client.query("update ml_strategic_items set default_group_id = $1, updated_at = now() where id = $2", [resolvedGroupId, storedItem.id]);
        }
        await client.query(`update ml_strategic_rounds set status = 'interrupted', impact = 'interrupted', interrupted_at = now(), updated_at = now() where account_key = $1 and mlb = $2 and status in ('active','ready','failed')`, [resolvedAccountKey, mlb]);
        const beforeMetrics = await captureMetrics({ state, sellerId, mlb, from: ranges.beforeFrom, to: ranges.beforeTo });
        const { rows } = await client.query(
          `insert into ml_strategic_rounds
            (item_id, account_key, account_label, seller_id, mlb, sku, title_snapshot, thumbnail_snapshot, alteration_date, review_due_date, window_days, group_id, source_task_id, task_batch_id, task_batch_name, status, impact, confidence, change_flags, change_notes, before_from, before_to, after_from, after_to, before_metrics)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'active','pending','pending',$16::jsonb,$17,$18,$19,$20,$21,$22::jsonb) returning *`,
          [storedItem.id, resolvedAccountKey, accountLabel || null, sellerId, mlb, itemPayload.sku, itemPayload.title, itemPayload.thumbnail, ranges.alterationDate, ranges.reviewDue, ranges.windowDays, resolvedGroupId, Number(sourceTaskId) || null, taskBatchId || null, taskBatchName || null, JSON.stringify(flags), String(changeNotes || "").trim() || null, ranges.beforeFrom, ranges.beforeTo, ranges.afterFrom, ranges.afterTo, JSON.stringify(beforeMetrics)],
        );
        await client.query("update ml_strategic_items set active_round_id = $1, updated_at = now() where id = $2", [rows[0].id, storedItem.id]);
        created.push(mapRoundRow(rows[0], storedItem));
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
  return { success: true, total: created.length, rows: created };
}
async function createTasks({ accessToken, mlCreds = {}, accountKey, accountLabel, empresaId = null, query = "", items = [], groupId = null, taskBatchId = "", taskBatchName = "", taskTags = [], taskTagColors = {}, taskFlags = {}, taskNotes = "", dueDate = null, analysisStartDate = null, priority = "medium", createdByUserId = null, requiredSectors = [] } = {}) {
  const resolvedAccountKey = safeAccountKey(accountKey || mlCreds?.meli_conta_id || mlCreds?.id || mlCreds?.meli_user_id);
  const resolvedGroupId = await resolveGroupId({ accountKey: resolvedAccountKey, groupId });
  const normalizedPriority = normalizePriority(priority);
  const normalizedDueDate = toYmd(dueDate);
  const normalizedAnalysisStartDate = toYmd(analysisStartDate);
  const flags = normalizeChangeFlags(taskFlags);
  const state = await prepareAuthState({ accessToken, mlCreds });
  const sellerId = await getSellerId(state, mlCreds);
  let normalizedItems = Array.isArray(items) ? items.filter((item) => normMlb(item?.mlb || item?.id)) : [];
  if (!normalizedItems.length) {
    const lookup = await lookupItems({ accessToken, mlCreds, accountKey: resolvedAccountKey, accountLabel, query });
    normalizedItems = lookup.rows;
  }
  if (!normalizedItems.length) throw new Error("Nenhum anuncio encontrado para criar pendencias.");
  const providedBatchId = String(taskBatchId || "").trim();
  const existingBatch = providedBatchId ? await getTaskBatch({ accountKey: resolvedAccountKey, batchId: providedBatchId }) : null;
  if (providedBatchId && !existingBatch) throw new Error("Lote de tarefas nao encontrado.");
  if (existingBatch && existingBatch.status !== "active") throw new Error("Este lote nao esta ativo para receber novos anuncios.");
  const batchId = existingBatch?.id || randomUUID();
  const batchName = existingBatch?.name || String(taskBatchName || "").trim().slice(0, 100) || defaultTaskBatchName(query, normalizedItems.length);
  const inputTags = normalizeTaskTagsPayload({ tags: taskTags, tagColors: taskTagColors });
  const existingTags = normalizeTaskTagsPayload({ tags: existingBatch?.tags || [], tagColors: existingBatch?.tag_colors || {} });
  const batchTags = existingBatch ? existingTags.tags : inputTags.tags;
  const batchTagColors = existingBatch ? existingTags.tagColors : inputTags.tagColors;
  const batchGroupId = existingBatch?.group_id ? Number(existingBatch.group_id) : resolvedGroupId;
  const batchPriority = existingBatch?.priority || normalizedPriority;
  const batchDueDate = existingBatch?.due_date ? toYmd(existingBatch.due_date) : normalizedDueDate;
  const batchAnalysisStartDate = existingBatch?.analysis_start_date ? toYmd(existingBatch.analysis_start_date) : normalizedAnalysisStartDate;
  const batchSectorFallback = existingBatch ? await listTaskBatchSectorDefinitions({ accountKey: resolvedAccountKey, batchId }) : [];
  const taskSectors = await normalizeTaskSectors({ empresaId, sectors: requiredSectors, flags, fallback: batchSectorFallback });
  const ids = uniq(normalizedItems.map((item) => normMlb(item.mlb || item.id)));
  const details = await fetchItemDetails(state, ids);
  const detailMap = new Map(details.map((item) => [normMlb(item.id), item]));
  const saved = [];
  const skippedItems = [];
  const historyItems = [];
  await db.withClient(async (client) => {
    await client.query("begin");
    try {
      await client.query(
        `insert into ml_strategic_task_batches
          (id, account_key, name, status, priority, due_date, analysis_start_date, tags, tag_colors, group_id, created_by_user_id, updated_at)
         values ($1,$2,$3,'active',$4,$5,$6,$7::text[],$8::jsonb,$9,$10,now())
         on conflict (id) do update set
           name = excluded.name,
           status = 'active',
           priority = excluded.priority,
           due_date = excluded.due_date,
           analysis_start_date = excluded.analysis_start_date,
           tags = excluded.tags,
           tag_colors = excluded.tag_colors,
           group_id = excluded.group_id,
           updated_at = now()
         where ml_strategic_task_batches.account_key = excluded.account_key`,
        [batchId, resolvedAccountKey, batchName, batchPriority, batchDueDate, batchAnalysisStartDate, batchTags, JSON.stringify(batchTagColors), batchGroupId, Number(createdByUserId) || null],
      );
      const processed = new Set();
      for (const raw of normalizedItems) {
        const mlb = normMlb(raw.mlb || raw.id);
        if (!mlb || processed.has(mlb)) continue;
        processed.add(mlb);
        const itemPayload = normalizeItemPayload(detailMap.get(mlb) || raw, { sellerId, accountKey: resolvedAccountKey, accountLabel });
        itemPayload.mlb = mlb;
        itemPayload.account_key = resolvedAccountKey;
        itemPayload.account_label = accountLabel || raw.account_label || null;
        itemPayload.seller_id = itemPayload.seller_id || sellerId;
        const existing = await client.query(
          `select id, status, task_batch_id, task_batch_name
             from ml_strategic_tasks
            where account_key = $1
              and mlb = $2
              and status in ('pending','in_progress','review','returned')
            order by created_at desc, id desc
            limit 1`,
          [resolvedAccountKey, mlb],
        );
        if (existing.rows.length) {
          const openTask = existing.rows[0];
          skippedItems.push({
            mlb,
            sku: itemPayload.sku || null,
            title: itemPayload.title || mlb,
            reason: "already_open",
            status: openTask.status || "pending",
            task_id: String(openTask.id),
            task_batch_id: openTask.task_batch_id || null,
            task_batch_name: openTask.task_batch_name || null,
          });
          continue;
        }
        const storedItem = await upsertItem(client, itemPayload);
        if (batchGroupId) {
          await client.query("update ml_strategic_items set default_group_id = $1, updated_at = now() where id = $2", [batchGroupId, storedItem.id]);
        }
        const previous = await client.query(
          `select
              count(distinct t.id)::int as previous_tasks,
              count(distinct r.id)::int as previous_rounds
             from (select 1) seed
             left join ml_strategic_tasks t
               on t.account_key = $1
              and t.mlb = $2
             left join ml_strategic_rounds r
               on r.account_key = $1
              and r.mlb = $2`,
          [resolvedAccountKey, mlb],
        );
        const previousTasks = Number(previous.rows?.[0]?.previous_tasks || 0);
        const previousRounds = Number(previous.rows?.[0]?.previous_rounds || 0);
        const { rows } = await client.query(
          `insert into ml_strategic_tasks
            (item_id, account_key, account_label, seller_id, mlb, sku, title_snapshot, thumbnail_snapshot, group_id, status, priority, task_flags, task_notes, due_date, analysis_start_date, created_by_user_id, task_batch_id, task_batch_name, task_batch_created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11::jsonb,$12,$13,$14,$15,$16,$17,now())
           returning *`,
          [storedItem.id, resolvedAccountKey, accountLabel || null, sellerId, mlb, itemPayload.sku, itemPayload.title, itemPayload.thumbnail, batchGroupId, batchPriority, JSON.stringify(flags), String(taskNotes || "").trim() || null, batchDueDate, batchAnalysisStartDate, Number(createdByUserId) || null, batchId, batchName],
        );
        await insertTaskSectors(client, rows[0].id, taskSectors, "pending");
        saved.push(mapTaskRow(rows[0]));
        if (previousTasks || previousRounds) {
          historyItems.push({
            mlb,
            sku: itemPayload.sku || null,
            title: itemPayload.title || mlb,
            previous_tasks: previousTasks,
            previous_rounds: previousRounds,
          });
        }
      }
      if (saved.length) {
        await client.query(
          `update ml_strategic_task_batches
              set updated_at = now()
            where id = $1
              and account_key = $2`,
          [batchId, resolvedAccountKey],
        );
      } else if (!existingBatch) {
        await client.query("delete from ml_strategic_task_batches where id = $1 and account_key = $2", [batchId, resolvedAccountKey]);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
  let integrationSync = { attempted: false, results: [] };
  if (saved.length) {
    try {
      integrationSync = await CompanyIntegrationsService.sendStrategicTasks({
        empresaId,
        accountKey: resolvedAccountKey,
        accountLabel,
        batch: {
          id: batchId,
          name: batchName,
          priority: batchPriority,
          due_date: batchDueDate,
          analysis_start_date: batchAnalysisStartDate,
          tags: batchTags,
          tag_colors: batchTagColors,
        },
        tasks: saved,
        sectors: taskSectors,
        taskFlags: flags,
        taskNotes,
      });
    } catch (error) {
      integrationSync = {
        attempted: true,
        results: [{ provider: "markflow", sent: 0, error: error?.message || "Falha ao enviar tarefas para integracao." }],
      };
    }
  }
  return {
    success: true,
    total: saved.length,
    inserted: saved.length,
    skipped: skippedItems.length,
    with_history: historyItems.length,
    integration_sync: integrationSync,
    tasks: saved,
    skipped_items: skippedItems,
    history_items: historyItems,
  };
}
function mapRoundRow(row, item = {}) {
  return {
    id: String(row.id), item_id: String(row.item_id), account_key: row.account_key, account_label: row.account_label, mlb: row.mlb,
    sku: row.sku || item.sku || null, title: row.title_snapshot || item.title || row.mlb, thumbnail: row.thumbnail_snapshot || item.thumbnail || null, permalink: item.permalink || null,
    group: row.group_id ? { id: String(row.group_id), name: row.group_name || null, color: row.group_color || "blue" } : null,
    source_task_id: row.source_task_id ? String(row.source_task_id) : null,
    task_batch_id: row.task_batch_id || null,
    task_batch_name: row.task_batch_name || null,
    task_tags: uniqueTaskTags(row.batch_tags || []),
    task_tag_colors: normalizeTaskTagColorsMap(row.batch_tag_colors, row.batch_tags || []),
    task_review: row.task_review_id ? {
      id: String(row.task_review_id),
      status: row.task_review_status || "open",
      flags: row.task_review_flags || {},
      reason: row.task_review_reason || "",
      created_at: row.task_review_created_at || null,
    } : null,
    alteration_date: toYmd(row.alteration_date), review_due_date: toYmd(row.review_due_date), window_days: row.window_days, status: row.status, impact: row.impact, confidence: row.confidence,
    change_flags: row.change_flags || {}, change_notes: row.change_notes || "", before_from: toYmd(row.before_from), before_to: toYmd(row.before_to), after_from: toYmd(row.after_from), after_to: toYmd(row.after_to),
    before_metrics: row.before_metrics || {}, after_metrics: row.after_metrics || {}, deltas: row.deltas || {}, insights: Array.isArray(row.insights) ? row.insights : [], error: row.error || null,
    reviewed_at: row.reviewed_at || null, created_at: row.created_at || null, updated_at: row.updated_at || null,
  };
}
function summarizeRounds(rounds = []) {
  const completed = rounds.filter((row) => row.status === "completed");
  return { total: rounds.length, active: rounds.filter((row) => row.status === "active" || row.status === "ready").length, completed: completed.length, improved: completed.filter((row) => row.impact === "improved").length, worse: completed.filter((row) => row.impact === "worse").length, stable: completed.filter((row) => row.impact === "stable").length, inconclusive: completed.filter((row) => row.impact === "inconclusive").length };
}
function buildDashboardInsights(rounds = [], summary = {}) {
  const insights = [];
  if (!rounds.length) return [{ type: "neutral", title: "Nenhum anuncio estrategico cadastrado", text: "Busque MLBs ou SKUs, registre o que foi alterado e deixe o sistema comparar o antes e depois." }];
  if (summary.active > 0) insights.push({ type: "info", title: `${summary.active} alteracoes em observacao`, text: "O sistema vai comparar automaticamente quando a janela de 7 dias fechar." });
  if (summary.improved > 0) insights.push({ type: "positive", title: `${summary.improved} alteracoes com melhora`, text: "Use estes casos como referencia antes de replicar mudancas em massa." });
  if (summary.worse > 0) insights.push({ type: "danger", title: `${summary.worse} alteracoes com queda`, text: "Priorize revisar esses anuncios antes de criar novas alteracoes parecidas." });
  if (!summary.improved && !summary.worse && summary.completed) insights.push({ type: "warning", title: "Resultados ainda pouco conclusivos", text: "Aumente a janela ou acompanhe itens com maior giro para reduzir ruido." });
  return insights.slice(0, 4);
}
async function listDashboard({ accountKey, limit = 25, page: requestedPage = 1, groupId = null, taskBatchId = null, taskTag = "", impact = "", analysisFrom = null, analysisTo = null, maxLimit = 25 } = {}) {
  const page = Math.max(1, Math.trunc(Number(requestedPage) || 1));
  const safeMaxLimit = Math.max(1, Math.min(500, Math.trunc(Number(maxLimit) || 25)));
  const safeLimit = Math.max(1, Math.min(safeMaxLimit, Math.trunc(Number(limit) || 25)));
  const offset = (page - 1) * safeLimit;
  const params = [safeAccountKey(accountKey)];
  const latestFilters = ["rn = 1", "status <> 'interrupted'"];
  const numericGroupId = Number(groupId);
  if (Number.isFinite(numericGroupId) && numericGroupId > 0) {
    params.push(numericGroupId);
    latestFilters.push(`group_id = $${params.length}`);
  }
  const cleanTaskBatchId = String(taskBatchId || "").trim();
  if (cleanTaskBatchId) {
    params.push(cleanTaskBatchId);
    latestFilters.push(`task_batch_id = $${params.length}`);
  }
  const cleanTaskTag = normalizeTagName(taskTag);
  if (cleanTaskTag) {
    params.push(cleanTaskTag.toLowerCase());
    latestFilters.push(`exists (
      select 1
        from unnest(coalesce(batch_tags, '{}'::text[])) as bt(tag)
       where lower(bt.tag) = $${params.length}
    )`);
  }
  const cleanImpact = String(impact || "").trim().toLowerCase();
  if (cleanImpact) {
    params.push(cleanImpact);
    latestFilters.push(`coalesce(impact, '') = $${params.length}`);
  }
  if (analysisFrom) {
    params.push(String(analysisFrom));
    latestFilters.push(`coalesce(alteration_date, created_at::date) >= $${params.length}::date`);
  }
  if (analysisTo) {
    params.push(String(analysisTo));
    latestFilters.push(`coalesce(alteration_date, created_at::date) <= $${params.length}::date`);
  }
  const latestWhere = `where ${latestFilters.join(" and ")}`;
  const baseCte = `
    with latest as (
      select r.*,
              i.sku as item_sku,
              i.title as item_title,
              i.thumbnail as item_thumbnail,
              i.permalink,
              g.name as group_name,
              g.color as group_color,
              tb.tags as batch_tags,
              tb.tag_colors as batch_tag_colors,
              rev.id as task_review_id,
              rev.status as task_review_status,
              rev.reopen_flags as task_review_flags,
              rev.reason as task_review_reason,
              rev.created_at as task_review_created_at,
              row_number() over (
                partition by r.account_key, r.mlb
                order by r.created_at desc, r.id desc
              ) as rn
        from ml_strategic_rounds r
        left join ml_strategic_items i on i.id = r.item_id
        left join ml_strategic_groups g on g.id = r.group_id
        left join ml_strategic_task_batches tb on tb.id = r.task_batch_id and tb.account_key = r.account_key
        left join lateral (
          select rv.id, rv.status, rv.reopen_flags, rv.reason, rv.created_at
            from ml_strategic_round_task_reviews rv
           where rv.round_id = r.id
             and rv.status = 'open'
           order by rv.created_at desc, rv.id desc
           limit 1
        ) rev on true
       where r.account_key = $1
         and (r.task_batch_id is not null or r.source_task_id is not null)
    )`;
  const summaryResult = await db.query(
    `${baseCte}
     select status, impact, count(*)::int as total
       from latest
      ${latestWhere}
      group by status, impact`,
    params,
  );
  const total = summaryResult.rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const summary = {
    total,
    active: summaryResult.rows.filter((row) => row.status === "active" || row.status === "ready").reduce((sum, row) => sum + Number(row.total || 0), 0),
    completed: summaryResult.rows.filter((row) => row.status === "completed").reduce((sum, row) => sum + Number(row.total || 0), 0),
    improved: summaryResult.rows.filter((row) => row.status === "completed" && row.impact === "improved").reduce((sum, row) => sum + Number(row.total || 0), 0),
    worse: summaryResult.rows.filter((row) => row.status === "completed" && row.impact === "worse").reduce((sum, row) => sum + Number(row.total || 0), 0),
    stable: summaryResult.rows.filter((row) => row.status === "completed" && row.impact === "stable").reduce((sum, row) => sum + Number(row.total || 0), 0),
    inconclusive: summaryResult.rows.filter((row) => row.status === "completed" && row.impact === "inconclusive").reduce((sum, row) => sum + Number(row.total || 0), 0),
  };
  const pageParams = [...params, safeLimit, offset];
  const { rows } = await db.query(
    `${baseCte}
     select *
       from latest
      ${latestWhere}
      order by case status when 'active' then 0 when 'ready' then 1 when 'failed' then 2 else 3 end,
               created_at desc,
               id desc
      limit $${pageParams.length - 1}
      offset $${pageParams.length}`,
    pageParams,
  );
  const rounds = rows.map((row) => mapRoundRow(row, { sku: row.item_sku, title: row.item_title, thumbnail: row.item_thumbnail, permalink: row.permalink }));
  const batchesResult = await db.query(
    `select
        r.task_batch_id as id,
        max(r.task_batch_name) as name,
        max(r.created_at) as last_seen_at,
        count(*)::int as total,
        coalesce(b.tags, '{}'::text[]) as tags,
        coalesce(b.tag_colors, '{}'::jsonb) as tag_colors
       from ml_strategic_rounds r
       left join ml_strategic_task_batches b on b.id = r.task_batch_id and b.account_key = r.account_key
      where r.account_key = $1
        and r.status <> 'interrupted'
        and r.task_batch_id is not null
      group by r.task_batch_id, b.tags, b.tag_colors
      order by max(r.created_at) desc, max(r.task_batch_name) asc`,
    [safeAccountKey(accountKey)],
  );
  const batches = batchesResult.rows.map((row) => ({
    id: row.id,
    name: row.name || `Lote #${row.id}`,
    total: Number(row.total || 0),
    last_seen_at: row.last_seen_at || null,
    tags: uniqueTaskTags(row.tags || []),
    tag_colors: normalizeTaskTagColorsMap(row.tag_colors, row.tags || []),
  }));
  const tags = uniq(
    batches.flatMap((batch) => Array.isArray(batch.tags) ? batch.tags : [])
      .map((tag) => normalizeTagName(tag))
      .filter(Boolean),
  ).sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));
  return { success: true, summary, insights: buildDashboardInsights(rounds, summary), rounds, batches, tags, page, limit: safeLimit, total, pages: Math.max(1, Math.ceil(total / safeLimit)) };
}
async function listWatchlist({ accountKey, empresaId = null, actor = {}, status = "active", listingStatus = "all", impact = "", query = "", limit = 25, page: requestedPage = 1 } = {}) {
  await assertStrategicActionPermission({ empresaId, actor, actionKey: "watchlist", mode: "view", message: "Seu setor nao possui permissao para visualizar a Watchlist." });
  const page = Math.max(1, Math.trunc(Number(requestedPage) || 1));
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 25)));
  const offset = (page - 1) * safeLimit;
  const params = [safeAccountKey(accountKey)];
  const filters = ["w.account_key = $1"];
  const statusValue = String(status || "active").trim().toLowerCase();
  if (statusValue === "active") filters.push("w.status <> 'removed'");
  else if (statusValue && statusValue !== "all") {
    params.push(statusValue);
    filters.push(`w.status = $${params.length}`);
  }
  const listingStatusValue = String(listingStatus || "all").trim().toLowerCase();
  if (listingStatusValue === "active") filters.push("coalesce(i.status, '') = 'active'");
  else if (listingStatusValue === "paused") filters.push("coalesce(i.status, '') = 'paused'");
  else if (listingStatusValue === "inactive") filters.push("coalesce(i.status, '') not in ('active','paused')");
  const q = String(query || "").trim();
  if (q) {
    params.push(`%${q.toUpperCase()}%`);
    filters.push(`(upper(w.mlb) like $${params.length} or upper(coalesce(w.sku,'')) like $${params.length} or upper(coalesce(w.title_snapshot,'')) like $${params.length})`);
  }
  const impactValue = String(impact || "").trim().toLowerCase();
  if (impactValue) {
    params.push(impactValue);
    filters.push(`coalesce(lr.impact, '') = $${params.length}`);
  }
  const whereSql = `where ${filters.join(" and ")}`;
  const count = await db.query(
    `select count(*)::int as total,
            count(*) filter (
              where not exists (
                select 1 from jsonb_each_text(coalesce(w.action_flags, '{}'::jsonb)) f(key, value)
                 where lower(f.value) = 'true'
              )
            )::int as no_action,
            count(*) filter (
              where exists (
                select 1 from jsonb_each_text(coalesce(w.action_flags, '{}'::jsonb)) f(key, value)
                 where lower(f.value) = 'true'
              )
            )::int as with_action,
            count(*) filter (where ot.id is not null)::int as task_open,
            count(*) filter (where w.status in ('analysis','action_registered'))::int as analysis
       from ml_strategic_watchlist w
       left join lateral (
         select t.id
           from ml_strategic_tasks t
          where t.account_key = w.account_key
            and t.mlb = w.mlb
            and t.status in ('pending','in_progress','review','returned')
         order by t.created_at desc, t.id desc
          limit 1
       ) ot on true
       left join lateral (
         select r.impact
           from ml_strategic_rounds r
          where r.account_key = w.account_key
            and r.mlb = w.mlb
            and r.task_batch_id is null
            and r.source_task_id is null
          order by coalesce(r.reviewed_at, r.created_at) desc, r.id desc
          limit 1
       ) lr on true
      ${whereSql}`,
    params,
  );
  const pageParams = [...params, safeLimit, offset];
  const { rows } = await db.query(
    watchlistBaseSelect(whereSql, `order by case when ot.id is not null then 0 when w.last_action_at is null then 1 else 2 end, w.updated_at desc, w.id desc limit $${pageParams.length - 1} offset $${pageParams.length}`),
    pageParams,
  );
  const items = rows.map(mapWatchlistRow);
  const summaryRow = count.rows?.[0] || {};
  const total = Number(summaryRow.total || 0);
  const summary = {
    total,
    no_action: Number(summaryRow.no_action || 0),
    with_action: Number(summaryRow.with_action || 0),
    task_open: Number(summaryRow.task_open || 0),
    analysis: Number(summaryRow.analysis || 0),
  };
  return { success: true, items, summary, page, limit: safeLimit, total, pages: Math.max(1, Math.ceil(total / safeLimit)) };
}

async function refreshWatchlistListingStatus({
  accessToken,
  mlCreds = {},
  accountKey,
  empresaId = null,
  actor = {},
  status = "active",
  listingStatus = "all",
  impact = "",
  query = "",
  refreshListing = true,
  compareRounds = true,
} = {}) {
  await assertStrategicActionPermission({ empresaId, actor, actionKey: "watchlist", mode: "view", message: "Seu setor nao possui permissao para atualizar a Watchlist." });
  const resolvedAccountKey = safeAccountKey(accountKey);
  const params = [resolvedAccountKey];
  const filters = ["w.account_key = $1"];
  const statusValue = String(status || "active").trim().toLowerCase();
  if (statusValue === "active") filters.push("w.status <> 'removed'");
  else if (statusValue && statusValue !== "all") {
    params.push(statusValue);
    filters.push(`w.status = $${params.length}`);
  }
  const listingStatusValue = String(listingStatus || "all").trim().toLowerCase();
  if (listingStatusValue === "active") filters.push("coalesce(i.status, '') = 'active'");
  else if (listingStatusValue === "paused") filters.push("coalesce(i.status, '') = 'paused'");
  else if (listingStatusValue === "inactive") filters.push("coalesce(i.status, '') not in ('active','paused')");
  const q = String(query || "").trim();
  if (q) {
    params.push(`%${q.toUpperCase()}%`);
    filters.push(`(upper(w.mlb) like $${params.length} or upper(coalesce(w.sku,'')) like $${params.length} or upper(coalesce(w.title_snapshot,'')) like $${params.length})`);
  }
  const impactValue = String(impact || "").trim().toLowerCase();
  if (impactValue) {
    params.push(impactValue);
    filters.push(`coalesce(lr.impact, '') = $${params.length}`);
  }
  const whereSql = `where ${filters.join(" and ")}`;
  const { rows } = await db.query(
    `select w.mlb,
            coalesce(w.sku, i.sku) as sku,
            coalesce(w.title_snapshot, i.title) as title_snapshot,
            coalesce(w.thumbnail_snapshot, i.thumbnail) as thumbnail_snapshot,
            coalesce(w.account_label, '') as account_label,
            w.last_action_at
       from ml_strategic_watchlist w
       left join ml_strategic_items i on i.id = w.item_id
       left join lateral (
         select r.impact
           from ml_strategic_rounds r
          where r.account_key = w.account_key
            and r.mlb = w.mlb
            and r.task_batch_id is null
            and r.source_task_id is null
          order by coalesce(r.reviewed_at, r.created_at) desc, r.id desc
          limit 1
      ) lr on true
      ${whereSql}
      order by w.updated_at desc, w.id desc`,
    params,
  );
  const ids = uniq(rows.map((row) => normMlb(row.mlb)).filter(Boolean));
  if (!ids.length) return { success: true, total: 0, updated: 0, not_found: 0 };
  let updated = 0;
  let notFound = 0;
  const shouldRefreshListing = !(String(refreshListing).toLowerCase() === "false" || refreshListing === 0);
  const shouldCompareRounds = !(String(compareRounds).toLowerCase() === "false" || compareRounds === 0);
  if (shouldRefreshListing) {
    const state = await prepareAuthState({ accessToken, mlCreds });
    const [details, promoMap, adsMap] = await Promise.all([
      fetchItemDetails(state, ids),
      fetchPromoMapForItems(state, ids),
      fetchAdsMapForItems(state, ids, { from: addDays(currentDateSaoPaulo(), -29), to: currentDateSaoPaulo() }),
    ]);
    const byId = new Map(details.map((item) => [normMlb(item.id), item]));
    await db.withClient(async (client) => {
      await client.query("begin");
      try {
        for (const row of rows) {
          const mlb = normMlb(row.mlb);
          if (!mlb) continue;
          const item = byId.get(mlb);
          if (!item) {
            notFound += 1;
            continue;
          }
          const normalized = normalizeItemPayload(item, {
            accountKey: resolvedAccountKey,
            accountLabel: row.account_label || null,
          });
          const listingBadges = listingBadgesFromItem(item, {
            promo: promoMap.get(mlb),
            ads: adsMap.get(mlb),
          });
          await upsertItem(client, normalized);
          await client.query(
            `update ml_strategic_watchlist
                set base_metrics = coalesce(base_metrics, '{}'::jsonb) || $3::jsonb,
                    updated_at = now()
              where account_key = $1
                and mlb = $2
                and status <> 'removed'`,
            [resolvedAccountKey, mlb, JSON.stringify({ listing_badges: listingBadges, listing_badges_updated_at: new Date().toISOString() })],
          );
          updated += 1;
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  }
  let compared = 0;
  let compareFailed = 0;
  if (shouldCompareRounds) {
    try {
      const latestRounds = await db.query(
        `with latest as (
           select distinct on (r.mlb) r.id, r.mlb
            from ml_strategic_rounds r
            where r.account_key = $1
              and r.mlb = any($2::text[])
              and r.task_batch_id is null
              and r.source_task_id is null
              and r.status <> 'interrupted'
            order by r.mlb, coalesce(r.reviewed_at, r.created_at) desc, r.id desc
         )
         select id, mlb from latest`,
        [resolvedAccountKey, ids],
      );
      const roundIdsToReview = [];
      const mlbsWithRound = new Set();
      for (const row of latestRounds.rows || []) {
        if (!row?.id) continue;
        roundIdsToReview.push(row.id);
        if (row?.mlb) mlbsWithRound.add(normMlb(row.mlb));
      }
      const missingForRound = rows.filter((row) => {
        const mlb = normMlb(row.mlb);
        return mlb && !mlbsWithRound.has(mlb);
      });
      for (const row of missingForRound) {
        try {
          const createdRound = await createRounds({
            accessToken,
            mlCreds,
            accountKey: resolvedAccountKey,
            accountLabel: row.account_label || null,
            items: [{
              mlb: row.mlb,
              sku: row.sku || null,
              title: row.title_snapshot || row.mlb,
              thumbnail: row.thumbnail_snapshot || null,
            }],
            changeFlags: {},
            changeNotes: "Round criado automaticamente pela Watchlist para comparacao de impacto.",
            alterationDate: toYmd(row.last_action_at) || currentDateSaoPaulo(),
          });
          const createdId = createdRound?.rows?.[0]?.id;
          if (createdId) roundIdsToReview.push(createdId);
          else compareFailed += 1;
        } catch (_) {
          compareFailed += 1;
        }
      }
      for (const roundId of roundIdsToReview) {
        try {
          await reviewRound({ roundId, accessToken, mlCreds, force: true });
          compared += 1;
        } catch (_) {
          compareFailed += 1;
        }
      }
    } catch (_) {
      compareFailed += 1;
    }
  }
  return { success: true, total: rows.length, updated, not_found: notFound, compared, compare_failed: compareFailed };
}
async function getWatchlistItemDetails({
  accessToken,
  mlCreds = {},
  accountKey,
  empresaId = null,
  actor = {},
  watchlistId,
  mode = "first_action",
  from = null,
  to = null,
} = {}) {
  await assertStrategicActionPermission({ empresaId, actor, actionKey: "watchlist", mode: "view", message: "Seu setor nao possui permissao para visualizar a Watchlist." });
  const id = Number(watchlistId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Item da Watchlist invalido.");
  const resolvedAccountKey = safeAccountKey(accountKey);

  const itemResult = await db.query(
    watchlistBaseSelect("where w.id = $1 and w.account_key = $2 and w.status <> 'removed'", "limit 1"),
    [id, resolvedAccountKey],
  );
  const row = itemResult.rows?.[0];
  if (!row) throw new Error("Item da Watchlist nao encontrado.");
  const item = mapWatchlistRow(row);

  const refsResult = await db.query(
    `select (w.created_at at time zone 'America/Sao_Paulo')::date as created_on,
            min(coalesce(e.occurred_on, (e.created_at at time zone 'America/Sao_Paulo')::date)) filter (where e.event_type = 'action_registered') as first_action_on,
            max(coalesce(e.occurred_on, (e.created_at at time zone 'America/Sao_Paulo')::date)) filter (where e.event_type = 'action_registered') as last_action_on,
            min((r.created_at at time zone 'America/Sao_Paulo')::date) as first_round_on,
            max((r.created_at at time zone 'America/Sao_Paulo')::date) as last_round_on
       from ml_strategic_watchlist w
       left join ml_strategic_watchlist_events e on e.watchlist_id = w.id
       left join ml_strategic_rounds r on r.account_key = w.account_key and r.mlb = w.mlb
      where w.id = $1
        and w.account_key = $2
      group by w.id, w.created_at`,
    [id, resolvedAccountKey],
  );
  const refs = refsResult.rows?.[0] || {};
  const dateRange = resolveWatchlistDateRange({
    mode,
    from,
    to,
    firstActionOn: refs.first_action_on,
    lastActionOn: refs.last_action_on,
    createdOn: refs.created_on,
  });

  const loadWatchlistEvents = async () => {
    const watchlistEventsResult = await db.query(
      `select e.id,
              e.event_type,
              e.action_flags,
              e.hypothesis,
              e.notes,
              e.primary_metric,
              e.window_days,
              e.occurred_on,
              e.source_task_id,
              e.source_round_id,
              e.payload,
              e.created_at,
              u.nome as user_name,
              u.email as user_email
         from ml_strategic_watchlist_events e
         left join usuarios u on u.id = e.created_by_user_id
        where e.watchlist_id = $1
          and e.account_key = $2
          and coalesce(e.occurred_on, (e.created_at at time zone 'America/Sao_Paulo')::date) between $3::date and $4::date
        order by e.created_at desc, e.id desc
        limit 200`,
      [id, resolvedAccountKey, dateRange.from, dateRange.to],
    );
    return watchlistEventsResult.rows.map((event) => ({
      id: String(event.id),
      at: event.created_at,
      event_type: event.event_type,
      occurred_on: toYmd(event.occurred_on),
      action_flags: normalizeChangeFlags(event.action_flags || {}),
      hypothesis: event.hypothesis || "",
      notes: event.notes || "",
      primary_metric: event.primary_metric || "",
      window_days: event.window_days || null,
      source_task_id: event.source_task_id ? String(event.source_task_id) : null,
      source_round_id: event.source_round_id ? String(event.source_round_id) : null,
      user_name: event.user_name || event.user_email || null,
      payload: event.payload || {},
    }));
  };
  let watchlistEvents = await loadWatchlistEvents();

  const taskRowsResult = await db.query(
    taskBaseSelect("where t.account_key = $1 and t.mlb = $2", "order by t.created_at desc, t.id desc limit 150"),
    [resolvedAccountKey, item.mlb],
  );
  const tasks = taskRowsResult.rows.map(mapTaskRow);
  const taskEvents = taskRowsResult.rows.flatMap((taskRow) => {
    const payload = normalizeExecutionPayload(taskRow.execution_payload);
    return payload.entries
      .map((entry) => ({
        at: entry.at,
        occurred_on: toYmd(entry.at),
        user_name: entry.user_name || null,
        notes: entry.notes || "",
        creates_round: entry.creates_round === true,
        round_id: entry.round_id ? String(entry.round_id) : null,
        task_id: String(taskRow.id),
        listing_changes: normalizeBoolMap(entry.listing_changes || {}, LISTING_CHANGE_KEYS),
        materials_created: normalizeBoolMap(entry.materials_created || {}, MATERIAL_KEYS),
        listing_not_applicable: normalizeBoolMap(entry.listing_not_applicable || {}, LISTING_CHANGE_KEYS),
        materials_not_applicable: normalizeBoolMap(entry.materials_not_applicable || {}, MATERIAL_KEYS),
        material_locations: entry.material_locations || {},
      }))
      .filter((entry) => entry.occurred_on && entry.occurred_on >= dateRange.from && entry.occurred_on <= dateRange.to);
  }).slice(0, 200);

  const roundsResult = await db.query(
    `select id,
            status,
            impact,
            confidence,
            alteration_date,
            review_due_date,
            change_flags,
            change_notes,
            before_metrics,
            after_metrics,
            deltas,
            insights,
            created_at,
            reviewed_at,
            task_batch_name,
            source_task_id
       from ml_strategic_rounds
      where account_key = $1
        and mlb = $2
        and coalesce(alteration_date, (created_at at time zone 'America/Sao_Paulo')::date) between $3::date and $4::date
      order by created_at desc, id desc
      limit 120`,
    [resolvedAccountKey, item.mlb, dateRange.from, dateRange.to],
  );
  const rounds = roundsResult.rows.map((round) => ({
    id: String(round.id),
    status: round.status,
    impact: round.impact,
    confidence: round.confidence,
    alteration_date: toYmd(round.alteration_date),
    review_due_date: toYmd(round.review_due_date),
    change_flags: normalizeChangeFlags(round.change_flags || {}),
    change_notes: round.change_notes || "",
    before_metrics: round.before_metrics || {},
    after_metrics: round.after_metrics || {},
    deltas: round.deltas || {},
    insights: Array.isArray(round.insights) ? round.insights : [],
    created_at: round.created_at,
    reviewed_at: round.reviewed_at,
    task_batch_name: round.task_batch_name || null,
    source_task_id: round.source_task_id ? String(round.source_task_id) : null,
  }));

  const stockWatchResult = await db.query(
    `select current_stock,
            sales_30d,
            avg_daily,
            coverage_days,
            stockout_date,
            trend,
            risk_level,
            suggested_restock,
            updated_at
       from ml_stock_watch_items
      where account_key = $1
        and mlb = $2
      limit 1`,
    [resolvedAccountKey, item.mlb],
  );
  const stockWatch = stockWatchResult.rows?.[0] || null;

  let liveListing = null;
  let liveMetrics = emptyMetrics(dateRange.from, dateRange.to);
  let previousMetrics = emptyMetrics(dateRange.previous_from, dateRange.previous_to);
  try {
    const state = await prepareAuthState({ accessToken, mlCreds: mlCreds || {} });

    // Sempre tenta ler o item + prazo usando a mesma lógica da tela /prazo,
    // independente das métricas comerciais.
    const [listing, prazoRow] = await Promise.all([
      mlJson(state, `/items/${encodeURIComponent(item.mlb)}`, {}, 2).catch(() => null),
      consultPrazoItemRow({ authState: state, mlbId: item.mlb }).catch(() => null),
    ]);
    liveListing = listing;
    const currentLeadTimeSnapshot = buildLeadTimeSnapshotFromPrazoRow(prazoRow);
    if (currentLeadTimeSnapshot) {
      liveListing = {
        ...(liveListing || {}),
        _manufacturing_time: {
          days: leadTimeSnapshotDays(currentLeadTimeSnapshot),
          label: leadTimeSnapshotLabel(currentLeadTimeSnapshot),
          updated_at: currentLeadTimeSnapshot.last_updated || null,
        },
      };
      const leadTimeEventResult = await db.withClient(async (client) => {
        await client.query("begin");
        try {
          const currentWatchlistResult = await client.query(
            `select id, base_metrics
               from ml_strategic_watchlist
              where id = $1
                and account_key = $2
                and status <> 'removed'
              for update`,
            [id, resolvedAccountKey],
          );
          const currentWatchlist = currentWatchlistResult.rows?.[0];
          if (!currentWatchlist) {
            await client.query("rollback");
            return { eventInserted: false };
          }
          const latestSnapshotResult = await client.query(
            `select payload
               from ml_strategic_watchlist_events
              where watchlist_id = $1
                and account_key = $2
                and payload ? 'lead_time_snapshot'
              order by created_at desc, id desc
              limit 1`,
            [id, resolvedAccountKey],
          );
          const previousLeadTimeSnapshot = findLatestLeadTimeSnapshot(
            latestSnapshotResult.rows?.length ? [{ payload: latestSnapshotResult.rows[0].payload }] : [],
            currentWatchlist.base_metrics || row.base_metrics || {},
          );
          const snapshotChanged = leadTimeSnapshotChanged(previousLeadTimeSnapshot, currentLeadTimeSnapshot);
          if (snapshotChanged) {
            const beforeLabel = previousLeadTimeSnapshot ? leadTimeSnapshotLabel(previousLeadTimeSnapshot) : "Nao informado";
            const afterLabel = leadTimeSnapshotLabel(currentLeadTimeSnapshot);
            const changeNotes = previousLeadTimeSnapshot
              ? `Prazo de fabricacao alterado: ${beforeLabel} -> ${afterLabel}.`
              : `Prazo de fabricacao registrado: ${afterLabel}.`;
            await client.query(
              `insert into ml_strategic_watchlist_events
                 (watchlist_id, account_key, mlb, event_type, notes, payload, occurred_on, created_by_user_id)
               values ($1,$2,$3,'lead_time_changed',$4,$5::jsonb,$6,$7)`,
              [
                id,
                resolvedAccountKey,
                item.mlb,
                changeNotes,
                JSON.stringify({
                  lead_time_snapshot: currentLeadTimeSnapshot,
                  previous_lead_time_snapshot: previousLeadTimeSnapshot || null,
                  from_days: previousLeadTimeSnapshot ? leadTimeSnapshotDays(previousLeadTimeSnapshot) : null,
                  to_days: leadTimeSnapshotDays(currentLeadTimeSnapshot),
                  from_label: previousLeadTimeSnapshot ? leadTimeSnapshotLabel(previousLeadTimeSnapshot) : null,
                  to_label: leadTimeSnapshotLabel(currentLeadTimeSnapshot),
                  detected_at: new Date().toISOString(),
                }),
                currentDateSaoPaulo(),
                null,
              ],
            );
          }
          await client.query(
            `update ml_strategic_watchlist
                set base_metrics = coalesce(base_metrics, '{}'::jsonb) || $3::jsonb,
                    updated_at = now()
              where id = $1
                and account_key = $2`,
            [id, resolvedAccountKey, JSON.stringify({ lead_time_snapshot: currentLeadTimeSnapshot })],
          );
          await client.query("commit");
          return { eventInserted: snapshotChanged };
        } catch (eventError) {
          await client.query("rollback");
          throw eventError;
        }
      });
      if (leadTimeEventResult?.eventInserted) {
        watchlistEvents = await loadWatchlistEvents();
      }
    }

    // Métricas ficam desacopladas: se sellerId/metricas falharem,
    // o prazo de fabricação continua disponível no detalhe.
    try {
      const sellerId = await getSellerId(state, mlCreds || {});
      const [metricsCurrent, metricsPrevious] = await Promise.all([
        captureMetrics({ state, sellerId, mlb: item.mlb, from: dateRange.from, to: dateRange.to }).catch(() => emptyMetrics(dateRange.from, dateRange.to)),
        captureMetrics({ state, sellerId, mlb: item.mlb, from: dateRange.previous_from, to: dateRange.previous_to }).catch(() => emptyMetrics(dateRange.previous_from, dateRange.previous_to)),
      ]);
      liveMetrics = metricsCurrent;
      previousMetrics = metricsPrevious;
    } catch (_metricsError) {
      // sem seller/metricas; mantem fallback vazio
    }
  } catch (error) {
    liveListing = null;
  }

  const roundAggregate = buildWatchlistRoundAggregate(rounds.map((round) => round.after_metrics || {}));
  const liveDelta = buildDeltas(previousMetrics, liveMetrics);
  const operationalHistory = taskEvents
    .filter((entry) => entry.listing_changes?.stock || entry.listing_changes?.lead_time || entry.listing_changes?.shipping || entry.listing_changes?.price)
    .map((entry) => ({
      at: entry.at,
      user_name: entry.user_name || null,
      notes: entry.notes || "",
      listing_changes: entry.listing_changes,
      material_locations: entry.material_locations || {},
      task_id: entry.task_id,
    }))
    .slice(0, 50);

  const liveStock = Number.isFinite(Number(liveListing?.available_quantity)) ? Math.trunc(Number(liveListing.available_quantity)) : null;
  const livePrice = Number.isFinite(Number(liveListing?.price)) ? Number(liveListing.price) : null;
  const liveLeadTimeDays = Number.isFinite(Number(liveListing?._manufacturing_time?.days))
    ? Math.trunc(Number(liveListing._manufacturing_time.days))
    : null;
  const liveLeadTimeLabel = liveListing?._manufacturing_time?.label || null;

  const stockSnapshot = {
    current_stock: liveStock != null ? liveStock : Number.isFinite(Number(stockWatch?.current_stock)) ? Number(stockWatch.current_stock) : null,
    stock_watch_stock: Number.isFinite(Number(stockWatch?.current_stock)) ? Number(stockWatch.current_stock) : null,
    price: livePrice != null ? livePrice : (Number.isFinite(Number(item?.price)) ? Number(item.price) : null),
    lead_time_days: liveLeadTimeDays,
    lead_time_label: liveLeadTimeLabel,
    lead_time_updated_at: liveListing?._manufacturing_time?.updated_at || null,
    coverage_days: Number.isFinite(Number(stockWatch?.coverage_days)) ? Number(stockWatch.coverage_days) : null,
    risk_level: stockWatch?.risk_level || null,
    trend: stockWatch?.trend || null,
    suggested_restock: Number.isFinite(Number(stockWatch?.suggested_restock)) ? Number(stockWatch.suggested_restock) : null,
    stockout_date: toYmd(stockWatch?.stockout_date),
    avg_daily_sales: Number.isFinite(Number(stockWatch?.avg_daily)) ? Number(stockWatch.avg_daily) : null,
    stock_watch_updated_at: stockWatch?.updated_at || null,
    has_stock_monitoring: !!stockWatch,
  };

  const insights = [];
  if (stockSnapshot.current_stock != null && stockSnapshot.current_stock <= 0) {
    insights.push({ type: "danger", title: "Estoque zerado", text: "O item esta sem estoque disponivel no anuncio." });
  } else if (stockSnapshot.coverage_days != null && stockSnapshot.coverage_days <= 7) {
    insights.push({ type: "warning", title: "Cobertura baixa", text: `Cobertura estimada em ${Number(stockSnapshot.coverage_days).toFixed(1)} dia(s).` });
  }
  if (liveDelta?.conversion?.delta != null) {
    if (liveDelta.conversion.delta <= -0.4) insights.push({ type: "danger", title: "Conversao em queda", text: `Queda de ${Math.abs(liveDelta.conversion.delta).toFixed(2)} p.p. no periodo comparado.` });
    else if (liveDelta.conversion.delta >= 0.4) insights.push({ type: "positive", title: "Conversao subiu", text: `Alta de ${Math.abs(liveDelta.conversion.delta).toFixed(2)} p.p. no periodo comparado.` });
  }
  if (watchlistEvents.length === 0 && rounds.length === 0) {
    insights.push({ type: "neutral", title: "Sem registros na janela", text: "Nao houve acoes ou monitoramentos no periodo selecionado." });
  }

  return {
    success: true,
    item,
    range: dateRange,
    references: {
      created_on: toYmd(refs.created_on),
      first_action_on: toYmd(refs.first_action_on),
      last_action_on: toYmd(refs.last_action_on),
      first_round_on: toYmd(refs.first_round_on),
      last_round_on: toYmd(refs.last_round_on),
    },
    live_metrics: liveMetrics,
    previous_metrics: previousMetrics,
    deltas: liveDelta,
    round_metrics: roundAggregate,
    rounds,
    watchlist_events: watchlistEvents,
    task_events: taskEvents,
    operational_history: operationalHistory,
    stock_snapshot: stockSnapshot,
    insights: insights.slice(0, 6),
  };
}
async function listWatchlistContains({ accountKey, mlbs = [], empresaId = null, actor = {} } = {}) {
  await assertStrategicActionPermission({ empresaId, actor, actionKey: "watchlist", mode: "view", message: "Seu setor nao possui permissao para visualizar a Watchlist." });
  const ids = uniq((Array.isArray(mlbs) ? mlbs : String(mlbs || "").split(",")).map(normMlb)).slice(0, 500);
  if (!ids.length) return { success: true, items: {} };
  const { rows } = await db.query(
    `select mlb, id, status
       from ml_strategic_watchlist
      where account_key = $1
        and mlb = any($2::text[])
        and status <> 'removed'`,
    [safeAccountKey(accountKey), ids],
  );
  return { success: true, items: Object.fromEntries(rows.map((row) => [row.mlb, { id: String(row.id), status: row.status }])) };
}
async function addSingleWatchlistItem({ accessToken, mlCreds = {}, accountKey, accountLabel, empresaId = null, actor = {}, query = "", item = null, reason = "", notes = "", baseMetrics = {}, createdByUserId = null } = {}) {
  await assertStrategicActionPermission({ empresaId, actor, actionKey: "watchlist", mode: "edit", message: "Seu setor nao possui permissao para editar a Watchlist." });
  const resolvedAccountKey = safeAccountKey(accountKey || mlCreds?.meli_conta_id || mlCreds?.id || mlCreds?.meli_user_id);
  const state = await prepareAuthState({ accessToken, mlCreds });
  const sellerId = await getSellerId(state, mlCreds);
  let payload = item && normMlb(item.mlb || item.id) ? item : null;
  if (!payload) {
    const lookup = await lookupItems({ accessToken, mlCreds, accountKey: resolvedAccountKey, accountLabel, query });
    payload = lookup.rows?.[0] || null;
  }
  const mlb = normMlb(payload?.mlb || payload?.id);
  if (!mlb) throw new Error("Informe um MLB ou SKU valido para adicionar a Watchlist.");
  const details = await fetchItemDetails(state, [mlb]);
  const itemPayload = normalizeItemPayload(details[0] || payload, { sellerId, accountKey: resolvedAccountKey, accountLabel });
  itemPayload.mlb = mlb;
  itemPayload.account_key = resolvedAccountKey;
  itemPayload.account_label = accountLabel || payload?.account_label || null;
  itemPayload.seller_id = itemPayload.seller_id || sellerId;
  const [promoMap, adsMap] = await Promise.all([
    fetchPromoMapForItems(state, [mlb]),
    fetchAdsMapForItems(state, [mlb], { from: addDays(currentDateSaoPaulo(), -29), to: currentDateSaoPaulo() }),
  ]);
  const listingBadges = listingBadgesFromItem(details[0] || payload || {}, {
    promo: promoMap.get(mlb),
    ads: adsMap.get(mlb),
  });
  const prazoRow = await consultPrazoItemRow({ authState: state, mlbId: mlb }).catch(() => null);
  const leadTimeSnapshot = buildLeadTimeSnapshotFromPrazoRow(prazoRow);
  const cleanBaseMetrics = baseMetrics && typeof baseMetrics === "object" ? { ...baseMetrics } : {};
  if (leadTimeSnapshot) cleanBaseMetrics.lead_time_snapshot = leadTimeSnapshot;
  cleanBaseMetrics.listing_badges = listingBadges;
  cleanBaseMetrics.listing_badges_updated_at = new Date().toISOString();
  const addedLeadTimeNote = leadTimeSnapshot ? `Prazo inicial registrado: ${leadTimeSnapshotLabel(leadTimeSnapshot)}.` : null;
  const addedNotes = [String(reason || notes || "").trim(), addedLeadTimeNote].filter(Boolean).join(" ").trim().slice(0, 1000) || null;
  let row = null;
  await db.withClient(async (client) => {
    await client.query("begin");
    try {
      const storedItem = await upsertItem(client, itemPayload);
      const result = await client.query(
        `insert into ml_strategic_watchlist
           (item_id, account_key, account_label, seller_id, mlb, sku, title_snapshot, thumbnail_snapshot, reason, notes, status, base_metrics, created_by_user_id, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'tracking',$11::jsonb,$12,now())
         on conflict (account_key, mlb) where status <> 'removed'
         do update set item_id = excluded.item_id,
                       account_label = excluded.account_label,
                       seller_id = excluded.seller_id,
                       sku = coalesce(excluded.sku, ml_strategic_watchlist.sku),
                       title_snapshot = coalesce(excluded.title_snapshot, ml_strategic_watchlist.title_snapshot),
                       thumbnail_snapshot = coalesce(excluded.thumbnail_snapshot, ml_strategic_watchlist.thumbnail_snapshot),
                       reason = coalesce(nullif(excluded.reason,''), ml_strategic_watchlist.reason),
                       notes = coalesce(nullif(excluded.notes,''), ml_strategic_watchlist.notes),
                       base_metrics = coalesce(ml_strategic_watchlist.base_metrics, '{}'::jsonb) || coalesce(excluded.base_metrics, '{}'::jsonb),
                       status = case when ml_strategic_watchlist.status = 'removed' then 'tracking' else ml_strategic_watchlist.status end,
                       updated_at = now()
         returning *`,
        [storedItem.id, resolvedAccountKey, accountLabel || null, sellerId, mlb, itemPayload.sku, itemPayload.title, itemPayload.thumbnail, String(reason || "").trim().slice(0, 300), String(notes || "").trim().slice(0, 1000), JSON.stringify(cleanBaseMetrics), Number(createdByUserId) || null],
      );
      row = result.rows[0];
      await client.query(
        `insert into ml_strategic_watchlist_events
           (watchlist_id, account_key, mlb, event_type, notes, payload, created_by_user_id)
         values ($1,$2,$3,'added',$4,$5::jsonb,$6)`,
        [row.id, resolvedAccountKey, mlb, addedNotes, JSON.stringify({ reason, base_metrics: cleanBaseMetrics, lead_time_snapshot: leadTimeSnapshot || null }), Number(createdByUserId) || null],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
  const fresh = await db.query(watchlistBaseSelect("where w.id = $1", "limit 1"), [row.id]);
  return { success: true, item: mapWatchlistRow(fresh.rows[0] || row) };
}
async function addWatchlistItem(params = {}) {
  const tokens = uniq(parseTokens(params.query || ""));
  if (!params.item && tokens.length > 100) {
    throw new Error("Informe no maximo 100 MLBs/SKUs por vez para adicionar a Watchlist.");
  }
  if (!params.item && tokens.length > 1) {
    const items = [];
    const failures = [];
    for (const token of tokens) {
      try {
        const result = await addSingleWatchlistItem({ ...params, query: token });
        if (result?.item) items.push(result.item);
      } catch (error) {
        failures.push({ query: token, message: error.message || "Nao foi possivel adicionar este item." });
      }
    }
    return {
      success: true,
      total: tokens.length,
      inserted: items.length,
      failed: failures.length,
      items,
      failures,
    };
  }
  return addSingleWatchlistItem({ ...params, query: tokens[0] || params.query || "" });
}
async function recordWatchlistAction({ accountKey, empresaId = null, actor = {}, watchlistId, actionFlags = {}, hypothesis = "", notes = "", occurredOn = null, primaryMetric = "", windowDays = DEFAULT_WINDOW_DAYS, userId = null } = {}) {
  await assertStrategicActionPermission({ empresaId, actor, actionKey: "watchlist", mode: "edit", message: "Seu setor nao possui permissao para editar a Watchlist." });
  const id = Number(watchlistId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Item da Watchlist invalido.");
  const resolvedAccountKey = safeAccountKey(accountKey);
  const flags = normalizeChangeFlags(actionFlags);
  if (!hasAnyTrue(flags)) throw new Error("Marque ao menos uma alteracao registrada.");
  const cleanDate = toYmd(occurredOn) || currentDateSaoPaulo();
  const cleanMetric = String(primaryMetric || "").trim().slice(0, 40) || "conversion";
  const cleanWindow = clampWindowDays(windowDays);
  let row = null;
  await db.withClient(async (client) => {
    await client.query("begin");
    try {
      const current = await client.query("select * from ml_strategic_watchlist where id = $1 and account_key = $2 and status <> 'removed' limit 1", [id, resolvedAccountKey]);
      row = current.rows[0];
      if (!row) throw new Error("Item da Watchlist nao encontrado.");
      const mergedFlags = normalizeChangeFlags({ ...(row.action_flags || {}), ...flags });
      await client.query(
        `insert into ml_strategic_watchlist_events
           (watchlist_id, account_key, mlb, event_type, action_flags, hypothesis, notes, primary_metric, window_days, occurred_on, created_by_user_id)
         values ($1,$2,$3,'action_registered',$4::jsonb,$5,$6,$7,$8,$9,$10)`,
        [id, resolvedAccountKey, row.mlb, JSON.stringify(flags), String(hypothesis || "").trim().slice(0, 1000) || null, String(notes || "").trim().slice(0, 2000) || null, cleanMetric, cleanWindow, cleanDate, Number(userId) || null],
      );
      await client.query(
        `update ml_strategic_watchlist
            set action_flags = $3::jsonb,
                status = 'analysis',
                last_action_at = now(),
                updated_at = now()
          where id = $1
            and account_key = $2`,
        [id, resolvedAccountKey, JSON.stringify(mergedFlags)],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
  const fresh = await db.query(watchlistBaseSelect("where w.id = $1", "limit 1"), [id]);
  return { success: true, item: mapWatchlistRow(fresh.rows[0]) };
}
async function removeWatchlistItem({ accountKey, empresaId = null, actor = {}, watchlistId, userId = null } = {}) {
  await assertStrategicActionPermission({ empresaId, actor, actionKey: "watchlist", mode: "edit", message: "Seu setor nao possui permissao para editar a Watchlist." });
  const id = Number(watchlistId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Item da Watchlist invalido.");
  const updated = await db.query(
    `update ml_strategic_watchlist
        set status = 'removed',
            removed_by_user_id = $3,
            removed_at = now(),
            updated_at = now()
      where id = $1
        and account_key = $2
      returning *`,
    [id, safeAccountKey(accountKey), Number(userId) || null],
  );
  if (!updated.rows.length) throw new Error("Item da Watchlist nao encontrado.");
  await db.query(
    `insert into ml_strategic_watchlist_events
       (watchlist_id, account_key, mlb, event_type, notes, created_by_user_id)
     values ($1,$2,$3,'removed','Removido da Watchlist',$4)`,
    [id, safeAccountKey(accountKey), updated.rows[0].mlb, Number(userId) || null],
  );
  return { success: true, removed: true, id: String(id) };
}

async function restoreWatchlistItem({ accountKey, empresaId = null, actor = {}, watchlistId, userId = null } = {}) {
  await assertStrategicActionPermission({ empresaId, actor, actionKey: "watchlist", mode: "edit", message: "Seu setor nao possui permissao para editar a Watchlist." });
  const id = Number(watchlistId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Item da Watchlist invalido.");
  const resolvedAccountKey = safeAccountKey(accountKey);
  const updated = await db.query(
    `update ml_strategic_watchlist
        set status = 'tracking',
            removed_by_user_id = null,
            removed_at = null,
            updated_at = now()
      where id = $1
        and account_key = $2
        and status = 'removed'
      returning id, mlb`,
    [id, resolvedAccountKey],
  );
  if (!updated.rows.length) throw new Error("Item removido da Watchlist nao encontrado.");
  await db.query(
    `insert into ml_strategic_watchlist_events
       (watchlist_id, account_key, mlb, event_type, notes, created_by_user_id)
     values ($1,$2,$3,'restored','Restaurado na Watchlist',$4)`,
    [id, resolvedAccountKey, updated.rows[0].mlb, Number(userId) || null],
  );
  const fresh = await db.query(watchlistBaseSelect("where w.id = $1 and w.account_key = $2", "limit 1"), [id, resolvedAccountKey]);
  return { success: true, restored: true, item: mapWatchlistRow(fresh.rows[0]) };
}

async function removeWatchlistItems({ accountKey, empresaId = null, actor = {}, watchlistIds = [], userId = null } = {}) {
  await assertStrategicActionPermission({ empresaId, actor, actionKey: "watchlist", mode: "edit", message: "Seu setor nao possui permissao para editar a Watchlist." });
  const ids = uniq((Array.isArray(watchlistIds) ? watchlistIds : []).map((id) => String(id || "").trim()))
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) throw new Error("Selecione ao menos um item da Watchlist.");
  const resolvedAccountKey = safeAccountKey(accountKey);
  let removed = 0;
  await db.withClient(async (client) => {
    await client.query("begin");
    try {
      const { rows } = await client.query(
        `update ml_strategic_watchlist
            set status = 'removed',
                removed_by_user_id = $3,
                removed_at = now(),
                updated_at = now()
          where account_key = $1
            and id = any($2::bigint[])
            and status <> 'removed'
          returning id, mlb`,
        [resolvedAccountKey, ids, Number(userId) || null],
      );
      removed = rows.length;
      for (const row of rows) {
        await client.query(
          `insert into ml_strategic_watchlist_events
             (watchlist_id, account_key, mlb, event_type, notes, created_by_user_id, payload)
           values ($1,$2,$3,'removed','Removido da Watchlist em massa.',$4,$5::jsonb)`,
          [row.id, resolvedAccountKey, row.mlb, Number(userId) || null, JSON.stringify({ bulk: true })],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
  return { success: true, removed };
}

async function recordWatchlistActionBulk({ accountKey, empresaId = null, actor = {}, watchlistIds = [], actionFlags = {}, hypothesis = "", notes = "", occurredOn = null, primaryMetric = "", windowDays = DEFAULT_WINDOW_DAYS, userId = null } = {}) {
  await assertStrategicActionPermission({ empresaId, actor, actionKey: "watchlist", mode: "edit", message: "Seu setor nao possui permissao para editar a Watchlist." });
  const ids = uniq((Array.isArray(watchlistIds) ? watchlistIds : []).map((id) => String(id || "").trim()))
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) throw new Error("Selecione ao menos um item da Watchlist.");
  let saved = 0;
  for (const id of ids) {
    await recordWatchlistAction({ accountKey, empresaId, actor, watchlistId: id, actionFlags, hypothesis, notes, occurredOn, primaryMetric, windowDays, userId });
    saved += 1;
  }
  return { success: true, saved };
}

async function addWatchlistTagsBulk({ accountKey, empresaId = null, actor = {}, watchlistIds = [], tag = "", color = "", userId = null } = {}) {
  await assertStrategicActionPermission({ empresaId, actor, actionKey: "watchlist", mode: "edit", message: "Seu setor nao possui permissao para editar a Watchlist." });
  const ids = uniq((Array.isArray(watchlistIds) ? watchlistIds : []).map((id) => String(id || "").trim()))
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) throw new Error("Selecione ao menos um item da Watchlist.");
  const cleanTag = normalizeTagName(tag);
  if (!cleanTag) throw new Error("Informe a tag.");
  const cleanColor = normalizeTagColor(color) || "#3b82f6";
  const resolvedAccountKey = safeAccountKey(accountKey);
  let updated = 0;
  await db.withClient(async (client) => {
    await client.query("begin");
    try {
      const { rows } = await client.query(
        `select id, mlb, base_metrics
           from ml_strategic_watchlist
          where account_key = $1
            and id = any($2::bigint[])
            and status <> 'removed'`,
        [resolvedAccountKey, ids],
      );
      for (const row of rows) {
        const current = row.base_metrics && typeof row.base_metrics === "object" ? row.base_metrics : {};
        const tags = uniqueTaskTags([...(Array.isArray(current.watchlist_tags) ? current.watchlist_tags : []), cleanTag]);
        const tagColors = normalizeTaskTagColorsMap({ ...(current.watchlist_tag_colors || {}), [cleanTag]: cleanColor }, tags);
        await client.query(
          `update ml_strategic_watchlist
              set base_metrics = coalesce(base_metrics, '{}'::jsonb) || $3::jsonb,
                  updated_at = now()
            where id = $1
              and account_key = $2`,
          [row.id, resolvedAccountKey, JSON.stringify({ watchlist_tags: tags, watchlist_tag_colors: tagColors })],
        );
        await client.query(
          `insert into ml_strategic_watchlist_events
             (watchlist_id, account_key, mlb, event_type, notes, created_by_user_id, payload)
           values ($1,$2,$3,'tag_added',$4,$5,$6::jsonb)`,
          [row.id, resolvedAccountKey, row.mlb, `Tag adicionada: ${cleanTag}`, Number(userId) || null, JSON.stringify({ tag: cleanTag, color: cleanColor, bulk: true })],
        );
        updated += 1;
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
  return { success: true, updated, tag: cleanTag, color: cleanColor };
}
async function createTaskFromWatchlist({ accessToken, mlCreds = {}, accountKey, accountLabel, empresaId = null, actor = {}, watchlistId, taskFlags = {}, taskNotes = "", requiredSectors = [], dueDate = null, priority = "medium", createdByUserId = null } = {}) {
  await assertStrategicActionPermission({ empresaId, actor, actionKey: "task.create", mode: "edit", message: "Seu setor nao possui permissao para criar tarefas." });
  await assertStrategicActionPermission({ empresaId, actor, actionKey: "watchlist", mode: "edit", message: "Seu setor nao possui permissao para criar tarefas pela Watchlist." });
  const id = Number(watchlistId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Item da Watchlist invalido.");
  const resolvedAccountKey = safeAccountKey(accountKey);
  const current = await db.query(watchlistBaseSelect("where w.id = $1 and w.account_key = $2 and w.status <> 'removed'", "limit 1"), [id, resolvedAccountKey]);
  const row = current.rows[0];
  if (!row) throw new Error("Item da Watchlist nao encontrado.");
  const flags = normalizeChangeFlags(taskFlags);
  const result = await createTasks({
    accessToken,
    mlCreds,
    accountKey: resolvedAccountKey,
    accountLabel,
    empresaId,
    items: [mapWatchlistRow(row)],
    taskFlags: flags,
    taskNotes: taskNotes || row.notes || row.reason || "",
    requiredSectors,
    dueDate,
    priority,
    createdByUserId,
    taskBatchName: `Watchlist - ${row.mlb}`,
  });
  const taskId = result.tasks?.[0]?.id || null;
  await db.query(
    `insert into ml_strategic_watchlist_events
       (watchlist_id, account_key, mlb, event_type, action_flags, notes, source_task_id, created_by_user_id, payload)
     values ($1,$2,$3,'task_created',$4::jsonb,$5,$6,$7,$8::jsonb)`,
    [id, resolvedAccountKey, row.mlb, JSON.stringify(flags), String(taskNotes || "").trim() || null, taskId ? Number(taskId) : null, Number(createdByUserId) || null, JSON.stringify({ result })],
  );
  await db.query("update ml_strategic_watchlist set status = 'task_open', updated_at = now() where id = $1 and account_key = $2", [id, resolvedAccountKey]);
  const fresh = await db.query(watchlistBaseSelect("where w.id = $1", "limit 1"), [id]);
  return { ...result, watchlist_item: mapWatchlistRow(fresh.rows[0] || row) };
}
async function listRoundHistory({ accountKey, mlb } = {}) {
  const normalizedMlb = normMlb(mlb);
  if (!normalizedMlb) throw new Error("MLB invalido.");
  const resolvedAccountKey = safeAccountKey(accountKey);
  const { rows } = await db.query(
    `select r.*,
            i.sku as item_sku,
            i.title as item_title,
            i.thumbnail as item_thumbnail,
            i.permalink,
            g.name as group_name,
            g.color as group_color,
            rev.id as task_review_id,
            rev.status as task_review_status,
            rev.reopen_flags as task_review_flags,
            rev.reason as task_review_reason,
            rev.created_at as task_review_created_at
       from ml_strategic_rounds r
       left join ml_strategic_items i on i.id = r.item_id
       left join ml_strategic_groups g on g.id = r.group_id
       left join lateral (
          select rv.id, rv.status, rv.reopen_flags, rv.reason, rv.created_at
            from ml_strategic_round_task_reviews rv
           where rv.round_id = r.id
             and rv.status = 'open'
           order by rv.created_at desc, rv.id desc
           limit 1
       ) rev on true
      where r.account_key = $1
        and r.mlb = $2
      order by r.created_at desc, r.id desc
      limit 100`,
    [resolvedAccountKey, normalizedMlb],
  );
  const rounds = rows.map((row) => mapRoundRow(row, { sku: row.item_sku, title: row.item_title, thumbnail: row.item_thumbnail, permalink: row.permalink }));
  const taskHistory = await db.query(
    taskBaseSelect(
      "where t.account_key = $1 and t.mlb = $2",
      "order by t.created_at desc, t.id desc limit 100",
    ),
    [resolvedAccountKey, normalizedMlb],
  );
  const tasks = taskHistory.rows.map(mapTaskRow);
  const watchlistHistory = await db.query(
    `select e.*,
            w.reason,
            w.notes as watchlist_notes,
            w.title_snapshot,
            w.thumbnail_snapshot,
            w.sku,
            u.nome as user_name,
            u.email as user_email
       from ml_strategic_watchlist_events e
       left join ml_strategic_watchlist w on w.id = e.watchlist_id
       left join usuarios u on u.id = e.created_by_user_id
      where e.account_key = $1
        and e.mlb = $2
      order by e.created_at desc, e.id desc
      limit 100`,
    [resolvedAccountKey, normalizedMlb],
  );
  const watchlistEvents = watchlistHistory.rows.map((event) => ({
    type: "watchlist_event",
    at: event.created_at,
    event_type: event.event_type,
    watchlist_id: String(event.watchlist_id),
    mlb: event.mlb,
    sku: event.sku || null,
    title: event.title_snapshot || event.mlb,
    thumbnail: event.thumbnail_snapshot || null,
    reason: event.reason || "",
    action_flags: normalizeChangeFlags(event.action_flags || {}),
    hypothesis: event.hypothesis || "",
    notes: event.notes || "",
    primary_metric: event.primary_metric || "",
    window_days: event.window_days || null,
    occurred_on: toYmd(event.occurred_on),
    source_task_id: event.source_task_id ? String(event.source_task_id) : null,
    source_round_id: event.source_round_id ? String(event.source_round_id) : null,
    user_name: event.user_name || event.user_email || null,
    payload: event.payload || {},
  }));
  const taskEvents = taskHistory.rows.flatMap((task) => {
    const payload = normalizeExecutionPayload(task.execution_payload);
    return payload.entries.map((entry) => ({
      ...entry,
      task_id: String(task.id),
      mlb: task.mlb,
      sku: task.sku || null,
      title: task.title_snapshot || task.mlb,
      thumbnail: task.thumbnail_snapshot || null,
    }));
  }).sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 100);
  const taskCreatedEvents = tasks.map((task) => ({
    type: "task_created",
    at: task.created_at,
    task_id: task.id,
    mlb: task.mlb,
    sku: task.sku,
    title: task.title,
    thumbnail: task.thumbnail,
    status: task.status,
    priority: task.priority,
    task_batch_id: task.task_batch_id,
    task_batch_name: task.task_batch_name,
    task_flags: task.task_flags,
    task_notes: task.task_notes,
    created_by: task.created_by,
  }));
  const executionTimeline = taskEvents.map((entry) => ({
    ...entry,
    type: "task_execution",
    at: entry.at,
    execution_type: entry.type || null,
  }));
  const monitoringStarted = rounds.map((round) => ({
    type: "monitoring_started",
    at: round.created_at,
    round,
  }));
  const monitoringResults = rounds
    .filter((round) => round.reviewed_at || round.status === "completed" || round.status === "ready")
    .map((round) => ({
      type: "monitoring_result",
      at: round.reviewed_at || round.updated_at || round.created_at,
      round,
    }));
  const timeline = [...watchlistEvents, ...taskCreatedEvents, ...executionTimeline, ...monitoringStarted, ...monitoringResults]
    .filter((event) => event.at)
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
    .slice(0, 200);
  const firstTask = taskHistory.rows?.[0] || null;
  const firstWatchlist = watchlistHistory.rows?.[0] || null;
  return {
    success: true,
    total: rounds.length,
    item: rounds[0]
      ? { mlb: rounds[0].mlb, sku: rounds[0].sku, title: rounds[0].title, thumbnail: rounds[0].thumbnail, permalink: rounds[0].permalink }
      : firstTask
        ? { mlb: firstTask.mlb, sku: firstTask.sku, title: firstTask.title_snapshot || firstTask.mlb, thumbnail: firstTask.thumbnail_snapshot }
        : firstWatchlist
          ? { mlb: firstWatchlist.mlb, sku: firstWatchlist.sku, title: firstWatchlist.title_snapshot || firstWatchlist.mlb, thumbnail: firstWatchlist.thumbnail_snapshot }
        : { mlb: normalizedMlb },
    tasks,
    task_events: taskEvents,
    watchlist_events: watchlistEvents,
    timeline,
    rounds,
  };
}
function mapTaskRow(row = {}) {
  const executionPayload = normalizeExecutionPayload(row.execution_payload);
  return {
    id: String(row.id),
    item_id: row.item_id ? String(row.item_id) : null,
    account_key: row.account_key,
    account_label: row.account_label,
    mlb: row.mlb,
    sku: row.sku || null,
    title: row.title_snapshot || row.item_title || row.mlb,
    thumbnail: row.thumbnail_snapshot || row.item_thumbnail || null,
    permalink: row.permalink || row.item_permalink || null,
    listing_status: row.item_status || null,
    group: row.group_id ? { id: String(row.group_id), name: row.group_name || null, color: row.group_color || "blue" } : null,
    status: row.status || "pending",
    priority: row.priority || "medium",
    task_batch_id: row.task_batch_id || null,
    task_batch_name: row.task_batch_name || null,
    task_batch_created_at: row.task_batch_created_at || null,
    task_tags: uniqueTaskTags(row.batch_tags || []),
    task_tag_colors: normalizeTaskTagColorsMap(row.batch_tag_colors, row.batch_tags || []),
    task_flags: row.task_flags || {},
    task_notes: row.task_notes || "",
    sectors: normalizeSectorRows(row.sectors),
    external_links: Array.isArray(row.external_links) ? row.external_links : [],
    execution_payload: executionPayload,
    latest_execution: executionPayload.entries.length ? executionPayload.entries[executionPayload.entries.length - 1] : null,
    due_date: toYmd(row.due_date),
    analysis_start_date: toYmd(row.analysis_start_date),
    batch_analysis_start_date: toYmd(row.batch_analysis_start_date),
    effective_analysis_start_date: toYmd(row.effective_analysis_start_date || row.analysis_start_date || row.batch_analysis_start_date),
    assigned_to: row.assigned_to_user_id
      ? { id: String(row.assigned_to_user_id), name: row.assigned_to_nome || row.assigned_to_email || null, email: row.assigned_to_email || null }
      : null,
    created_by: row.created_by_user_id
      ? { id: String(row.created_by_user_id), name: row.created_by_nome || row.created_by_email || null, email: row.created_by_email || null }
      : null,
    completed_by: row.completed_by_user_id
      ? { id: String(row.completed_by_user_id), name: row.completed_by_nome || row.completed_by_email || null, email: row.completed_by_email || null }
      : null,
    created_round_id: row.created_round_id ? String(row.created_round_id) : null,
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    canceled_by: row.canceled_by_user_id
      ? { id: String(row.canceled_by_user_id), name: row.canceled_by_nome || row.canceled_by_email || null, email: row.canceled_by_email || null }
      : null,
    canceled_at: row.canceled_at || null,
    cancel_reason: row.cancel_reason || "",
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}
function taskBaseSelect(whereSql = "", orderSql = "order by t.created_at desc, t.id desc") {
  return `select t.*,
                 tb.analysis_start_date as batch_analysis_start_date,
                 coalesce(t.analysis_start_date, tb.analysis_start_date) as effective_analysis_start_date,
                 g.name as group_name,
                 g.color as group_color,
                 au.nome as assigned_to_nome,
                 au.email as assigned_to_email,
                 cu.nome as created_by_nome,
                 cu.email as created_by_email,
                 bu.nome as completed_by_nome,
                 bu.email as completed_by_email,
                 xu.nome as canceled_by_nome,
                 xu.email as canceled_by_email,
                 i.status as item_status,
                 i.permalink as item_permalink,
                 i.thumbnail as item_thumbnail,
                 i.title as item_title,
                 coalesce(tb.tags, '{}'::text[]) as batch_tags,
                 coalesce(tb.tag_colors, '{}'::jsonb) as batch_tag_colors,
                 coalesce(st.sectors, '[]'::jsonb) as sectors,
                 coalesce(el.external_links, '[]'::jsonb) as external_links
            from ml_strategic_tasks t
            left join ml_strategic_task_batches tb on tb.id = t.task_batch_id and tb.account_key = t.account_key
            left join ml_strategic_items i on i.id = t.item_id
            left join ml_strategic_groups g on g.id = t.group_id
            left join usuarios au on au.id = t.assigned_to_user_id
            left join usuarios cu on cu.id = t.created_by_user_id
            left join usuarios bu on bu.id = t.completed_by_user_id
            left join usuarios xu on xu.id = t.canceled_by_user_id
            left join lateral (
              select jsonb_agg(jsonb_build_object(
                       'id', s.id,
                       'key', s.setor,
                       'setor', s.setor,
                       'label', s.label,
                       'status', s.status,
                       'assigned_at', s.assigned_at,
                       'completed_at', s.completed_at,
                       'assigned_to', case when u.id is null then null else jsonb_build_object('id', u.id::text, 'name', coalesce(u.nome, u.email), 'email', u.email) end
                     ) order by s.label asc, s.setor asc) as sectors
                from ml_strategic_task_sectors s
                left join usuarios u on u.id = s.assigned_user_id
               where s.task_id = t.id
            ) st on true
            left join lateral (
              select jsonb_agg(jsonb_build_object(
                       'id', l.id,
                       'provider', l.provider,
                       'external_task_id', l.external_task_id,
                       'external_url', l.external_url,
                       'external_status', l.external_status,
                       'last_sync_at', l.last_sync_at,
                       'last_error', l.last_error
                     ) order by l.atualizado_em desc, l.id desc) as external_links
                from ml_external_task_links l
               where l.task_id = t.id
            ) el on true
            ${whereSql}
            ${orderSql}`;
}
async function listTasks({ accountKey, status = "open", groupId = null, sector = "", tag = "", batchId = "", batchName = "", priority = "", query = "", scope = "", createdFrom = null, createdTo = null, analysisFrom = null, analysisTo = null, dueFrom = null, dueTo = null, prioritizeMyPending = true, actor = {}, limit = 25, page: requestedPage = 1 } = {}) {
  const page = Math.max(1, Math.trunc(Number(requestedPage) || 1));
  const safeLimit = Math.max(1, Math.min(25, Math.trunc(Number(limit) || 25)));
  const offset = (page - 1) * safeLimit;
  const params = [safeAccountKey(accountKey)];
  const filters = ["t.account_key = $1"];
  const statusValue = String(status || "open").trim().toLowerCase();
  if (statusValue === "open") filters.push("t.status in ('pending','in_progress','review','returned')");
  else if (statusValue && statusValue !== "all") {
    const normalizedStatus = normalizeTaskStatus(statusValue);
    if (normalizedStatus) {
      params.push(normalizedStatus);
      filters.push(`t.status = $${params.length}`);
    }
  }
  if (priority) {
    params.push(normalizePriority(priority));
    filters.push(`t.priority = $${params.length}`);
  }
  const createdFromYmd = toYmd(createdFrom);
  const createdToYmd = toYmd(createdTo);
  const analysisFromYmd = toYmd(analysisFrom);
  const analysisToYmd = toYmd(analysisTo);
  const dueFromYmd = toYmd(dueFrom);
  const dueToYmd = toYmd(dueTo);
  if (createdFromYmd) {
    params.push(createdFromYmd);
    filters.push(`t.created_at::date >= $${params.length}`);
  }
  if (createdToYmd) {
    params.push(createdToYmd);
    filters.push(`t.created_at::date <= $${params.length}`);
  }
  if (analysisFromYmd) {
    params.push(analysisFromYmd);
    filters.push(`t.analysis_start_date >= $${params.length}`);
  }
  if (analysisToYmd) {
    params.push(analysisToYmd);
    filters.push(`t.analysis_start_date <= $${params.length}`);
  }
  if (dueFromYmd) {
    params.push(dueFromYmd);
    filters.push(`t.due_date >= $${params.length}`);
  }
  if (dueToYmd) {
    params.push(dueToYmd);
    filters.push(`t.due_date <= $${params.length}`);
  }
  const numericGroupId = Number(groupId);
  if (Number.isFinite(numericGroupId) && numericGroupId > 0) {
    params.push(numericGroupId);
    filters.push(`t.group_id = $${params.length}`);
  }
  const cleanSector = sectorKey(sector);
  if (cleanSector) {
    params.push(cleanSector);
    filters.push(`exists (
      select 1
        from ml_strategic_task_sectors sf
       where sf.task_id = t.id
         and sf.setor = $${params.length}
    )`);
  }
  const cleanTag = normalizeTagName(tag);
  if (cleanTag) {
    params.push(cleanTag.toLowerCase());
    filters.push(`exists (
      select 1
        from ml_strategic_task_batches bt
       where bt.id = t.task_batch_id
         and bt.account_key = t.account_key
         and exists (
           select 1
             from unnest(coalesce(bt.tags, '{}'::text[])) as btt(tag)
            where lower(btt.tag) = $${params.length}
         )
    )`);
  }
  const normalizedActor = normalizeActor(actor);
  if (String(scope || "").trim().toLowerCase() === "mine" && !normalizedActor.isAdmin && normalizedActor.sectors.length) {
    params.push(normalizedActor.sectors);
    filters.push(`exists (
      select 1
        from ml_strategic_task_sectors sm
       where sm.task_id = t.id
         and sm.setor = any($${params.length}::text[])
         and sm.status in ('pending','in_progress','review','returned')
    )`);
  }
  const cleanBatchId = String(batchId || "").trim();
  if (cleanBatchId) {
    params.push(cleanBatchId);
    filters.push(`coalesce(t.task_batch_id, concat('legacy-', coalesce(t.group_id::text, 'sem-grupo'))) = $${params.length}`);
  }
  const cleanBatchName = String(batchName || "").trim();
  if (cleanBatchName) {
    params.push(cleanBatchName.toLowerCase());
    filters.push(`lower(coalesce(t.task_batch_name,'')) = $${params.length}`);
  }
  const search = String(query || "").trim();
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    filters.push(`(lower(t.mlb) like $${params.length} or lower(coalesce(t.sku,'')) like $${params.length} or lower(coalesce(t.title_snapshot,'')) like $${params.length} or lower(coalesce(t.task_batch_name,'')) like $${params.length})`);
  }
  const whereSql = `where ${filters.join(" and ")}`;
  const countResult = await db.query(`select count(*)::int as total from ml_strategic_tasks t ${whereSql}`, params);
  const total = Number(countResult.rows?.[0]?.total || 0);
  const pageParams = [...params];
  let focusSectorOrderSql = "";
  const prioritizeEnabled = prioritizeMyPending !== false && String(prioritizeMyPending).toLowerCase() !== "false" && String(prioritizeMyPending) !== "0";
  const orderSectors = cleanSector ? [cleanSector] : normalizedActor.sectors;
  if (prioritizeEnabled && orderSectors.length) {
    pageParams.push(orderSectors);
    const orderSectorsParam = `$${pageParams.length}`;
    focusSectorOrderSql = `
                case
                  when coalesce(i.status, '') not in ('active', 'paused') then 9
                  when exists (
                    select 1
                      from ml_strategic_task_sectors sp
                     where sp.task_id = t.id
                       and sp.setor = any(${orderSectorsParam}::text[])
                       and sp.status in ('pending','returned')
                  ) then 0
                  when exists (
                    select 1
                      from ml_strategic_task_sectors si
                     where si.task_id = t.id
                       and si.setor = any(${orderSectorsParam}::text[])
                       and si.status in ('in_progress','review')
                  ) then 1
                  when not exists (
                    select 1
                      from ml_strategic_task_sectors sx
                     where sx.task_id = t.id
                       and sx.setor = any(${orderSectorsParam}::text[])
                  ) then 2
                  when exists (
                    select 1
                      from ml_strategic_task_sectors sc
                     where sc.task_id = t.id
                       and sc.setor = any(${orderSectorsParam}::text[])
                       and sc.status = 'completed'
                  ) then 3
                  else 4
                end,`;
  }
  pageParams.push(safeLimit, offset);
  const { rows } = await db.query(
    taskBaseSelect(
      whereSql,
      `order by ${focusSectorOrderSql}
                case when coalesce(i.status, '') = 'active' then 0 when coalesce(i.status, '') = 'paused' then 1 else 2 end,
                case t.status when 'returned' then 0 when 'review' then 1 when 'in_progress' then 2 when 'pending' then 3 else 4 end,
                case t.priority when 'high' then 0 when 'medium' then 1 else 2 end,
                t.due_date asc nulls last,
                t.created_at desc
       limit $${pageParams.length - 1}
       offset $${pageParams.length}`,
    ),
    pageParams,
  );
  const summaryResult = await db.query(
    `select status, priority, count(*)::int as total,
            count(*) filter (where due_date is not null and due_date < current_date and status in ('pending','in_progress','review','returned'))::int as overdue
       from ml_strategic_tasks t
      ${whereSql}
      group by status, priority`,
    params,
  );
  const summary = summaryResult.rows.reduce(
    (acc, row) => {
      const count = Number(row.total || 0);
      if (["pending", "in_progress", "review", "returned"].includes(row.status)) acc.open += count;
      if (row.status === "pending") acc.pending += count;
      if (row.status === "in_progress") acc.in_progress += count;
      if (row.status === "review") acc.review += count;
      if (row.status === "returned") acc.returned += count;
      if (row.status === "completed") acc.completed += count;
      if (row.priority === "high" && ["pending", "in_progress", "review", "returned"].includes(row.status)) acc.high += count;
      acc.overdue += Number(row.overdue || 0);
      return acc;
    },
    { open: 0, pending: 0, in_progress: 0, review: 0, returned: 0, completed: 0, high: 0, overdue: 0 },
  );
  return { success: true, tasks: rows.map(mapTaskRow), summary, page, limit: safeLimit, total, pages: Math.max(1, Math.ceil(total / safeLimit)) };
}
async function listTaskBatches({ accountKey, status = "open", groupId = null, sector = "", tag = "", priority = "", batchName = "", query = "", scope = "", createdFrom = null, createdTo = null, analysisFrom = null, analysisTo = null, dueFrom = null, dueTo = null, actor = {} } = {}) {
  const params = [safeAccountKey(accountKey)];
  const filters = ["b.account_key = $1"];
  const statusValue = String(status || "open").trim().toLowerCase();
  if (statusValue === "open") {
    filters.push("b.status = 'active'");
    filters.push("exists (select 1 from ml_strategic_tasks tx where tx.task_batch_id = b.id and tx.status in ('pending','in_progress','review','returned'))");
  }
  else if (statusValue && statusValue !== "all") {
    const normalizedBatchStatus = normalizeBatchStatus(statusValue);
    const normalizedTaskStatus = normalizeTaskStatus(statusValue);
    if (normalizedBatchStatus) {
      params.push(normalizedBatchStatus);
      filters.push(`b.status = $${params.length}`);
    } else if (normalizedTaskStatus) {
      params.push(normalizedTaskStatus);
      filters.push(`exists (select 1 from ml_strategic_tasks tx where tx.task_batch_id = b.id and tx.status = $${params.length})`);
    }
  }
  if (priority) {
    params.push(normalizePriority(priority));
    filters.push(`b.priority = $${params.length}`);
  }
  const createdFromYmd = toYmd(createdFrom);
  const createdToYmd = toYmd(createdTo);
  const analysisFromYmd = toYmd(analysisFrom);
  const analysisToYmd = toYmd(analysisTo);
  const dueFromYmd = toYmd(dueFrom);
  const dueToYmd = toYmd(dueTo);
  if (createdFromYmd) {
    params.push(createdFromYmd);
    filters.push(`exists (select 1 from ml_strategic_tasks tx where tx.task_batch_id = b.id and tx.account_key = b.account_key and tx.created_at::date >= $${params.length})`);
  }
  if (createdToYmd) {
    params.push(createdToYmd);
    filters.push(`exists (select 1 from ml_strategic_tasks tx where tx.task_batch_id = b.id and tx.account_key = b.account_key and tx.created_at::date <= $${params.length})`);
  }
  if (analysisFromYmd) {
    params.push(analysisFromYmd);
    filters.push(`exists (select 1 from ml_strategic_tasks tx where tx.task_batch_id = b.id and tx.account_key = b.account_key and tx.analysis_start_date >= $${params.length})`);
  }
  if (analysisToYmd) {
    params.push(analysisToYmd);
    filters.push(`exists (select 1 from ml_strategic_tasks tx where tx.task_batch_id = b.id and tx.account_key = b.account_key and tx.analysis_start_date <= $${params.length})`);
  }
  if (dueFromYmd) {
    params.push(dueFromYmd);
    filters.push(`exists (select 1 from ml_strategic_tasks tx where tx.task_batch_id = b.id and tx.account_key = b.account_key and tx.due_date >= $${params.length})`);
  }
  if (dueToYmd) {
    params.push(dueToYmd);
    filters.push(`exists (select 1 from ml_strategic_tasks tx where tx.task_batch_id = b.id and tx.account_key = b.account_key and tx.due_date <= $${params.length})`);
  }
  const numericGroupId = Number(groupId);
  if (Number.isFinite(numericGroupId) && numericGroupId > 0) {
    params.push(numericGroupId);
    filters.push(`b.group_id = $${params.length}`);
  }
  const cleanSector = sectorKey(sector);
  if (cleanSector) {
    params.push(cleanSector);
    filters.push(`exists (
      select 1
        from ml_strategic_tasks tsf
        join ml_strategic_task_sectors sf on sf.task_id = tsf.id
       where tsf.task_batch_id = b.id
         and tsf.account_key = b.account_key
         and sf.setor = $${params.length}
    )`);
  }
  const cleanTag = normalizeTagName(tag);
  if (cleanTag) {
    params.push(cleanTag.toLowerCase());
    filters.push(`exists (
      select 1
        from unnest(coalesce(b.tags, '{}'::text[])) as bt(tag)
       where lower(bt.tag) = $${params.length}
    )`);
  }
  const cleanBatchName = String(batchName || "").trim();
  if (cleanBatchName) {
    params.push(cleanBatchName.toLowerCase());
    filters.push(`lower(coalesce(b.name,'')) = $${params.length}`);
  }
  const normalizedActor = normalizeActor(actor);
  if (String(scope || "").trim().toLowerCase() === "mine" && !normalizedActor.isAdmin && normalizedActor.sectors.length) {
    params.push(normalizedActor.sectors);
    filters.push(`exists (
      select 1
        from ml_strategic_tasks tsm
        join ml_strategic_task_sectors sm on sm.task_id = tsm.id
       where tsm.task_batch_id = b.id
         and tsm.account_key = b.account_key
         and sm.setor = any($${params.length}::text[])
         and sm.status in ('pending','in_progress','review','returned')
    )`);
  }
  const search = String(query || "").trim();
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    filters.push(`(lower(b.name) like $${params.length} or exists (
      select 1 from ml_strategic_tasks tx
       where tx.task_batch_id = b.id
         and (lower(tx.mlb) like $${params.length} or lower(coalesce(tx.sku,'')) like $${params.length} or lower(coalesce(tx.title_snapshot,'')) like $${params.length})
    ))`);
  }
  const whereSql = `where ${filters.join(" and ")}`;
  const { rows } = await db.query(
    `select b.*,
            g.name as group_name,
            g.color as group_color,
            u.nome as created_by_nome,
            u.email as created_by_email,
            (
              select coalesce(jsonb_object_agg(flags.key, true), '{}'::jsonb)
                from (
                  select distinct f.key
                    from ml_strategic_tasks tf
                    cross join lateral jsonb_each_text(coalesce(tf.task_flags, '{}'::jsonb)) f(key, value)
                   where tf.account_key = b.account_key
                     and tf.task_batch_id = b.id
                     and tf.status in ('pending','in_progress','review','returned')
                     and f.value = 'true'
                ) flags
            ) as task_flags,
            max(coalesce(t.updated_at, b.updated_at)) as latest_task_update,
            count(*)::int as total,
            count(*) filter (where t.status = 'pending')::int as pending,
            count(*) filter (where t.status = 'in_progress')::int as in_progress,
            count(*) filter (where t.status = 'review')::int as review,
            count(*) filter (where t.status = 'returned')::int as returned,
            count(*) filter (where t.status = 'completed')::int as completed,
            count(*) filter (where t.status = 'canceled')::int as canceled,
            count(*) filter (where t.priority = 'high' and t.status in ('pending','in_progress','review','returned'))::int as high,
            count(*) filter (where t.due_date is not null and t.due_date < current_date and t.status in ('pending','in_progress','review','returned'))::int as overdue,
            min(t.due_date) filter (where t.status in ('pending','in_progress','review','returned')) as next_due_date,
            (
              select coalesce(jsonb_agg(jsonb_build_object(
                'key', grouped.setor,
                'setor', grouped.setor,
                'label', grouped.label,
                'status', case
                  when grouped.total > 0 and grouped.completed >= grouped.total then 'completed'
                  when grouped.review > 0 then 'review'
                  when grouped.in_progress > 0 then 'in_progress'
                  when grouped.canceled > 0 and grouped.pending = 0 then 'canceled'
                  else 'pending'
                end,
                'total', grouped.total,
                'pending', grouped.pending,
                'in_progress', grouped.in_progress,
                'review', grouped.review,
                'completed', grouped.completed,
                'canceled', grouped.canceled,
                'assigned_to', grouped.assigned_to
              ) order by grouped.label asc), '[]'::jsonb)
              from (
                select s.setor,
                       max(s.label) as label,
                       count(*)::int as total,
                       count(*) filter (where s.status = 'pending')::int as pending,
                       count(*) filter (where s.status = 'in_progress')::int as in_progress,
                       count(*) filter (where s.status = 'review')::int as review,
                       count(*) filter (where s.status = 'completed')::int as completed,
                       count(*) filter (where s.status = 'canceled')::int as canceled,
                       (
                       select jsonb_build_object('id', u.id::text, 'name', coalesce(u.nome, u.email), 'email', u.email)
                         from ml_strategic_task_sectors sx
                         join ml_strategic_tasks tx on tx.id = sx.task_id
                         join usuarios u on u.id = sx.assigned_user_id
                        where tx.account_key = b.account_key
                          and tx.task_batch_id = b.id
                          and tx.status in ('pending','in_progress','review','returned')
                          and sx.setor = s.setor
                        order by sx.assigned_at desc nulls last, sx.updated_at desc
                        limit 1
                     ) as assigned_to
                from ml_strategic_task_sectors s
                join ml_strategic_tasks ts on ts.id = s.task_id
               where ts.account_key = b.account_key
                 and ts.task_batch_id = b.id
                 and ts.status in ('pending','in_progress','review','returned')
               group by s.setor
            ) grouped
          ) as sectors
       from ml_strategic_task_batches b
       left join ml_strategic_tasks t on t.task_batch_id = b.id
       left join ml_strategic_groups g on g.id = b.group_id
       left join usuarios u on u.id = b.created_by_user_id
      ${whereSql}
      group by b.id, g.name, g.color, u.nome, u.email
      having count(t.id) > 0
      order by case when count(*) filter (where t.status = 'returned') > 0 then 0
                    when count(*) filter (where t.status = 'review') > 0 then 1
                    when count(*) filter (where t.status = 'in_progress') > 0 then 2
                    when count(*) filter (where t.status = 'pending') > 0 then 3
                    else 4 end,
               max(coalesce(t.updated_at, b.updated_at)) desc
      limit 80`,
    params,
  );
  const mapped = rows.map(mapTaskBatchRow);
  const tags = uniq(
    mapped.flatMap((batch) => Array.isArray(batch.tags) ? batch.tags : [])
      .map((value) => normalizeTagName(value))
      .filter(Boolean),
  ).sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));
  return { success: true, batches: mapped, tags };
}
async function refreshTaskListingStatus({
  accessToken,
  mlCreds = {},
  accountKey,
  status = "open",
  groupId = null,
  sector = "",
  tag = "",
  batchId = "",
  batchName = "",
  priority = "",
  query = "",
  scope = "",
  createdFrom = null,
  createdTo = null,
  analysisFrom = null,
  analysisTo = null,
  dueFrom = null,
  dueTo = null,
  actor = {},
} = {}) {
  const resolvedAccountKey = safeAccountKey(accountKey);
  const params = [resolvedAccountKey];
  const filters = ["t.account_key = $1"];
  const statusValue = String(status || "open").trim().toLowerCase();
  if (statusValue === "open") filters.push("t.status in ('pending','in_progress','review','returned')");
  else if (statusValue && statusValue !== "all") {
    const normalizedStatus = normalizeTaskStatus(statusValue);
    if (normalizedStatus) {
      params.push(normalizedStatus);
      filters.push(`t.status = $${params.length}`);
    }
  }
  if (priority) {
    params.push(normalizePriority(priority));
    filters.push(`t.priority = $${params.length}`);
  }
  const createdFromYmd = toYmd(createdFrom);
  const createdToYmd = toYmd(createdTo);
  const analysisFromYmd = toYmd(analysisFrom);
  const analysisToYmd = toYmd(analysisTo);
  const dueFromYmd = toYmd(dueFrom);
  const dueToYmd = toYmd(dueTo);
  if (createdFromYmd) {
    params.push(createdFromYmd);
    filters.push(`t.created_at::date >= $${params.length}`);
  }
  if (createdToYmd) {
    params.push(createdToYmd);
    filters.push(`t.created_at::date <= $${params.length}`);
  }
  if (analysisFromYmd) {
    params.push(analysisFromYmd);
    filters.push(`t.analysis_start_date >= $${params.length}`);
  }
  if (analysisToYmd) {
    params.push(analysisToYmd);
    filters.push(`t.analysis_start_date <= $${params.length}`);
  }
  if (dueFromYmd) {
    params.push(dueFromYmd);
    filters.push(`t.due_date >= $${params.length}`);
  }
  if (dueToYmd) {
    params.push(dueToYmd);
    filters.push(`t.due_date <= $${params.length}`);
  }
  const numericGroupId = Number(groupId);
  if (Number.isFinite(numericGroupId) && numericGroupId > 0) {
    params.push(numericGroupId);
    filters.push(`t.group_id = $${params.length}`);
  }
  const cleanSector = sectorKey(sector);
  if (cleanSector) {
    params.push(cleanSector);
    filters.push(`exists (
      select 1
        from ml_strategic_task_sectors sf
       where sf.task_id = t.id
         and sf.setor = $${params.length}
    )`);
  }
  const cleanTag = normalizeTagName(tag);
  if (cleanTag) {
    params.push(cleanTag.toLowerCase());
    filters.push(`exists (
      select 1
        from ml_strategic_task_batches bt
       where bt.id = t.task_batch_id
         and bt.account_key = t.account_key
         and exists (
           select 1
             from unnest(coalesce(bt.tags, '{}'::text[])) as btt(tag)
            where lower(btt.tag) = $${params.length}
         )
    )`);
  }
  const normalizedActor = normalizeActor(actor);
  if (String(scope || "").trim().toLowerCase() === "mine" && !normalizedActor.isAdmin && normalizedActor.sectors.length) {
    params.push(normalizedActor.sectors);
    filters.push(`exists (
      select 1
        from ml_strategic_task_sectors sm
       where sm.task_id = t.id
         and sm.setor = any($${params.length}::text[])
         and sm.status in ('pending','in_progress','review','returned')
    )`);
  }
  const cleanBatchId = String(batchId || "").trim();
  if (cleanBatchId) {
    params.push(cleanBatchId);
    filters.push(`coalesce(t.task_batch_id, concat('legacy-', coalesce(t.group_id::text, 'sem-grupo'))) = $${params.length}`);
  }
  const cleanBatchName = String(batchName || "").trim();
  if (cleanBatchName) {
    params.push(cleanBatchName.toLowerCase());
    filters.push(`lower(coalesce(t.task_batch_name,'')) = $${params.length}`);
  }
  const search = String(query || "").trim();
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    filters.push(`(lower(t.mlb) like $${params.length} or lower(coalesce(t.sku,'')) like $${params.length} or lower(coalesce(t.title_snapshot,'')) like $${params.length} or lower(coalesce(t.task_batch_name,'')) like $${params.length})`);
  }
  const whereSql = `where ${filters.join(" and ")}`;
  const { rows } = await db.query(
    `select distinct on (upper(t.mlb))
            upper(t.mlb) as mlb,
            coalesce(t.account_label, '') as account_label
       from ml_strategic_tasks t
      ${whereSql}
        and coalesce(t.mlb, '') <> ''
      order by upper(t.mlb) asc, t.updated_at desc nulls last, t.id desc
      limit 500`,
    params,
  );
  const ids = uniq(rows.map((row) => normMlb(row.mlb)).filter(Boolean));
  if (!ids.length) return { success: true, total: 0, updated: 0, not_found: 0 };
  const authState = await prepareAuthState({ accessToken, mlCreds });
  const details = await fetchItemDetails(authState, ids);
  const byId = new Map(details.map((item) => [normMlb(item.id), item]));
  let updated = 0;
  let notFound = 0;
  await db.withClient(async (client) => {
    await client.query("begin");
    try {
      for (const row of rows) {
        const mlb = normMlb(row.mlb);
        if (!mlb) continue;
        const item = byId.get(mlb);
        if (!item) {
          notFound += 1;
          continue;
        }
        const normalized = normalizeItemPayload(item, {
          accountKey: resolvedAccountKey,
          accountLabel: row.account_label || null,
        });
        await upsertItem(client, normalized);
        updated += 1;
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
  return { success: true, total: rows.length, updated, not_found: notFound };
}

async function updateTaskBatch({ accountKey, empresaId = null, batchId, name, priority, dueDate, analysisStartDate, taskTags = undefined, taskTagColors = undefined, taskFlags = undefined, requiredSectors = undefined, groupId = undefined, status = null } = {}) {
  const resolvedAccountKey = safeAccountKey(accountKey);
  const batch = await getTaskBatch({ accountKey: resolvedAccountKey, batchId });
  if (!batch) throw new Error("Lote de tarefas nao encontrado.");
  const updates = ["updated_at = now()"];
  const params = [String(batchId), resolvedAccountKey];
  if (name !== undefined) {
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("Informe o nome do lote.");
    params.push(cleanName.slice(0, 100));
    updates.push(`name = $${params.length}`);
  }
  if (priority !== undefined) {
    params.push(normalizePriority(priority));
    updates.push(`priority = $${params.length}`);
  }
  if (dueDate !== undefined) {
    params.push(toYmd(dueDate));
    updates.push(`due_date = $${params.length}`);
  }
  if (analysisStartDate !== undefined) {
    params.push(toYmd(analysisStartDate));
    updates.push(`analysis_start_date = $${params.length}`);
  }
  if (taskTags !== undefined || taskTagColors !== undefined) {
    const fallbackTags = taskTags !== undefined ? taskTags : (batch.tags || []);
    const fallbackColors = taskTagColors !== undefined ? taskTagColors : (batch.tag_colors || {});
    const normalizedTags = normalizeTaskTagsPayload({ tags: fallbackTags, tagColors: fallbackColors });
    params.push(normalizedTags.tags);
    updates.push(`tags = $${params.length}::text[]`);
    params.push(JSON.stringify(normalizedTags.tagColors));
    updates.push(`tag_colors = $${params.length}::jsonb`);
  }
  if (groupId !== undefined) {
    const resolvedGroupId = await resolveGroupId({ accountKey: resolvedAccountKey, groupId });
    params.push(resolvedGroupId);
    updates.push(`group_id = $${params.length}`);
  }
  const normalizedStatus = normalizeBatchStatus(status);
  if (normalizedStatus) {
    params.push(normalizedStatus);
    updates.push(`status = $${params.length}`);
    if (normalizedStatus === "archived") updates.push("archived_at = coalesce(archived_at, now())");
    if (normalizedStatus === "canceled") updates.push("canceled_at = coalesce(canceled_at, now())");
    if (normalizedStatus === "active") updates.push("archived_at = null", "canceled_at = null");
  }
  const { rows } = await db.query(
    `update ml_strategic_task_batches
        set ${updates.join(", ")}
      where id = $1
        and account_key = $2
      returning *`,
    params,
  );
  if (!rows.length) throw new Error("Lote de tarefas nao encontrado.");
  if (name !== undefined) {
    await db.query(
      `update ml_strategic_tasks
          set task_batch_name = $3,
              updated_at = now()
        where task_batch_id = $1
          and account_key = $2`,
      [String(batchId), resolvedAccountKey, String(name || "").trim().slice(0, 100)],
    );
    await db.query(
      `update ml_strategic_rounds
          set task_batch_name = $3,
              updated_at = now()
        where task_batch_id = $1
          and account_key = $2`,
      [String(batchId), resolvedAccountKey, String(name || "").trim().slice(0, 100)],
    );
  }
  if (analysisStartDate !== undefined) {
    await db.query(
      `update ml_strategic_tasks
          set analysis_start_date = $3,
              updated_at = now()
        where task_batch_id = $1
          and account_key = $2
          and status in ('pending','in_progress','review','returned')
          and (analysis_start_date is null or analysis_start_date = $4)`,
      [String(batchId), resolvedAccountKey, toYmd(analysisStartDate), toYmd(batch.analysis_start_date)],
    );
  }
  let affectedOpenTasks = 0;
  if (taskFlags !== undefined || requiredSectors !== undefined) {
    await db.withClient(async (client) => {
      await client.query("begin");
      try {
        const openTasksResult = await client.query(
          `select id
             from ml_strategic_tasks
            where task_batch_id = $1
              and account_key = $2
              and status in ('pending','in_progress','review','returned')`,
          [String(batchId), resolvedAccountKey],
        );
        const openTaskIds = openTasksResult.rows.map((row) => Number(row.id)).filter((value) => Number.isFinite(value) && value > 0);
        affectedOpenTasks = openTaskIds.length;

        let normalizedFlags = null;
        if (taskFlags !== undefined) {
          normalizedFlags = normalizeChangeFlags(taskFlags);
          if (!hasAnyTrue(normalizedFlags)) throw new Error("Marque ao menos uma tarefa programada para o lote.");
          await client.query(
            `update ml_strategic_tasks
                set task_flags = $3::jsonb,
                    updated_at = now()
              where task_batch_id = $1
                and account_key = $2
                and status in ('pending','in_progress','review','returned')`,
            [String(batchId), resolvedAccountKey, JSON.stringify(normalizedFlags)],
          );
        }

        if (requiredSectors !== undefined) {
          if (Array.isArray(requiredSectors) && !requiredSectors.length) {
            throw new Error("Selecione ao menos um setor responsavel para o lote.");
          }
          const fallbackFlags = normalizedFlags || normalizeChangeFlags(batch.task_flags || {});
          const fallbackSectorDefs = await listTaskBatchSectorDefinitions({ accountKey: resolvedAccountKey, batchId });
          const nextSectors = await normalizeTaskSectors({
            empresaId,
            sectors: requiredSectors,
            flags: fallbackFlags,
            fallback: fallbackSectorDefs,
          });
          if (!nextSectors.length) throw new Error("Selecione ao menos um setor responsavel para o lote.");
          const selectedKeys = uniq(nextSectors.map((sector) => sectorKey(sector.key || sector.setor)).filter(Boolean));
          if (!selectedKeys.length) throw new Error("Selecione ao menos um setor responsavel para o lote.");

          if (openTaskIds.length) {
            const valueRows = [];
            const valueParams = [];
            nextSectors.forEach((sector) => {
              const key = sectorKey(sector.key || sector.setor);
              if (!key) return;
              const label = String(sector.label || "").trim() || sectorLabelFromKey(key);
              // $1 e $2 ja sao reservados para (task_batch_id, account_key).
              // O bloco VALUES precisa iniciar em $3 para manter a ordem dos parametros.
              valueRows.push(`($${valueParams.length + 3}, $${valueParams.length + 4})`);
              valueParams.push(key, label);
            });
            if (valueRows.length) {
              await client.query(
                `insert into ml_strategic_task_sectors (task_id, setor, label, status, updated_at)
                 select t.id, picked.setor, picked.label, 'pending', now()
                   from ml_strategic_tasks t
                   join (values ${valueRows.join(",")}) as picked(setor, label) on true
                  where t.task_batch_id = $1
                    and t.account_key = $2
                    and t.status in ('pending','in_progress','review','returned')
                 on conflict (task_id, setor) do update set
                   label = excluded.label,
                   updated_at = now()`,
                [String(batchId), resolvedAccountKey, ...valueParams],
              );
            }

            await client.query(
              `delete from ml_strategic_task_sectors s
                using ml_strategic_tasks t
               where s.task_id = t.id
                 and t.task_batch_id = $1
                 and t.account_key = $2
                 and t.status in ('pending','in_progress','review','returned')
                 and not (s.setor = any($3::text[]))`,
              [String(batchId), resolvedAccountKey, selectedKeys],
            );

            for (const taskId of openTaskIds) {
              await syncTaskStatusFromSectors(client, taskId, null);
            }
          }
        }

        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  }
  const fresh = await getTaskBatch({ accountKey: resolvedAccountKey, batchId });
  return { success: true, batch: mapTaskBatchRow(fresh), affected_open_tasks: affectedOpenTasks };
}
async function cancelTaskBatch({ accountKey, batchId, userId = null } = {}) {
  const resolvedAccountKey = safeAccountKey(accountKey);
  const batch = await getTaskBatch({ accountKey: resolvedAccountKey, batchId });
  if (!batch) throw new Error("Lote de tarefas nao encontrado.");
  await db.withClient(async (client) => {
    await client.query("begin");
    try {
      await client.query(
        `update ml_strategic_tasks
            set status = 'canceled',
                assigned_to_user_id = coalesce(assigned_to_user_id, $3),
                updated_at = now()
          where account_key = $1
            and task_batch_id = $2
            and status in ('pending','in_progress','review','returned')`,
        [resolvedAccountKey, String(batchId), Number(userId) || null],
      );
      await client.query(
        `update ml_strategic_task_batches
            set status = 'canceled',
                canceled_at = coalesce(canceled_at, now()),
                updated_at = now()
          where account_key = $1
            and id = $2`,
        [resolvedAccountKey, String(batchId)],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
  const fresh = await getTaskBatch({ accountKey: resolvedAccountKey, batchId });
  return { success: true, batch: mapTaskBatchRow(fresh) };
}
async function updateTaskStatus({ accountKey, taskId, status, userId = null, cancelReason = "", analysisStartDate = undefined } = {}) {
  const id = Number(taskId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Pendencia invalida.");
  const hasStatus = status !== undefined && status !== null && String(status || "").trim() !== "";
  const hasAnalysisStartDate = analysisStartDate !== undefined;
  const normalizedStatus = hasStatus ? normalizeTaskStatus(status) : null;
  if (hasStatus && (!normalizedStatus || !["pending", "in_progress", "review", "canceled"].includes(normalizedStatus))) throw new Error("Status de pendencia invalido.");
  if (!hasStatus && !hasAnalysisStartDate) throw new Error("Nenhuma alteracao informada para a pendencia.");
  const reason = normalizeCancelReason(cancelReason);
  if (normalizedStatus === "canceled" && !reason) throw new Error("Informe o motivo do cancelamento.");
  let row = null;
  await db.withClient(async (client) => {
    await client.query("begin");
    try {
      const updates = ["updated_at = now()"];
      const params = [id, safeAccountKey(accountKey)];
      if (hasStatus) {
        params.push(normalizedStatus);
        updates.push(`status = $${params.length}`);
      }
      if (hasAnalysisStartDate) {
        params.push(toYmd(analysisStartDate));
        updates.push(`analysis_start_date = $${params.length}`);
      }
      if (normalizedStatus === "in_progress") {
        params.push(Number(userId) || null);
        updates.push(`assigned_to_user_id = coalesce(assigned_to_user_id, $${params.length})`);
        updates.push("started_at = coalesce(started_at, now())");
      }
      if (normalizedStatus === "canceled") {
        params.push(Number(userId) || null);
        updates.push(`canceled_by_user_id = $${params.length}`);
        updates.push("canceled_at = now()");
        params.push(reason);
        updates.push(`cancel_reason = $${params.length}`);
      }
      const updated = await client.query(
        `update ml_strategic_tasks
            set ${updates.join(", ")}
          where id = $1
            and account_key = $2
          returning *`,
        params,
      );
      if (!updated.rows.length) throw new Error("Pendencia nao encontrada.");
      row = updated.rows[0];
      if (normalizedStatus === "canceled") {
        await client.query(
          `update ml_strategic_task_sectors
              set status = 'canceled',
                  updated_at = now()
            where task_id = $1
              and status <> 'completed'`,
          [id],
        );
        await client.query(
          `insert into ml_strategic_task_sector_events (task_id, setor, user_id, action, note, payload)
           values ($1,null,$2,'task_canceled',$3,$4::jsonb)`,
          [id, Number(userId) || null, reason, JSON.stringify({ reason })],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
  const fresh = await db.query(taskBaseSelect("where t.id = $1 and t.account_key = $2", "limit 1"), [id, safeAccountKey(accountKey)]);
  return { success: true, task: mapTaskRow(fresh.rows[0] || row) };
}
async function claimTaskBatchSector({ accountKey, batchId, sector, userId = null, actor = {} } = {}) {
  const resolvedAccountKey = safeAccountKey(accountKey);
  const cleanBatchId = String(batchId || "").trim();
  const cleanSector = sectorKey(sector);
  if (!cleanBatchId) throw new Error("Lote de tarefas invalido.");
  if (!cleanSector) throw new Error("Setor invalido.");
  assertActorCanUseSectors(actor, [cleanSector], "Este usuario nao possui permissao operacional para assumir este setor.");
  const uid = Number(userId) || null;
  if (!uid) throw new Error("Usuario nao identificado para assumir a tarefa.");
  const batch = await getTaskBatch({ accountKey: resolvedAccountKey, batchId: cleanBatchId });
  if (!batch) throw new Error("Lote de tarefas nao encontrado.");
  const alreadyAssigned = await db.query(
    `select s.setor, max(s.label) as label
       from ml_strategic_task_sectors s
       join ml_strategic_tasks t on t.id = s.task_id
      where t.account_key = $1
        and t.task_batch_id = $2
        and t.status in ('pending','in_progress','review','returned')
        and s.status in ('pending','in_progress','review','returned')
        and s.assigned_user_id = $3
        and s.setor <> $4
      group by s.setor
      limit 1`,
    [resolvedAccountKey, cleanBatchId, uid, cleanSector],
  );
  if (alreadyAssigned.rows[0]) {
    const label = alreadyAssigned.rows[0].label || sectorLabelFromKey(alreadyAssigned.rows[0].setor);
    const error = new Error(`Este usuario ja assumiu o setor ${label} neste lote. Cada usuario pode assumir apenas uma funcao por lote.`);
    error.statusCode = 409;
    throw error;
  }
  let claimed = 0;
  let blocked = 0;
  await db.withClient(async (client) => {
    await client.query("begin");
    try {
      const existing = await client.query(
        `select s.id, s.task_id, s.setor, s.assigned_user_id
           from ml_strategic_task_sectors s
           join ml_strategic_tasks t on t.id = s.task_id
          where t.account_key = $1
            and t.task_batch_id = $2
            and t.status in ('pending','in_progress','review','returned')
            and s.setor = $3
            and s.status in ('pending','in_progress','review','returned')`,
        [resolvedAccountKey, cleanBatchId, cleanSector],
      );
      if (!existing.rows.length) throw new Error("Este lote nao possui pendencias abertas para este setor.");
      blocked = existing.rows.filter((row) => row.assigned_user_id && Number(row.assigned_user_id) !== uid).length;
      const selfRows = existing.rows.filter((row) => Number(row.assigned_user_id) === uid);
      if (selfRows.length) {
        claimed = selfRows.length;
        await client.query("commit");
        return;
      }
      const updated = await client.query(
        `update ml_strategic_task_sectors s
            set status = 'in_progress',
                assigned_user_id = coalesce(s.assigned_user_id, $4),
                assigned_at = case when s.assigned_user_id is null then now() else s.assigned_at end,
                updated_at = now()
          from ml_strategic_tasks t
          where t.id = s.task_id
            and t.account_key = $1
            and t.task_batch_id = $2
            and t.status in ('pending','in_progress','review','returned')
            and s.setor = $3
            and s.status in ('pending','in_progress','review','returned')
            and (s.assigned_user_id is null or s.assigned_user_id = $4)
          returning s.task_id, s.setor`,
        [resolvedAccountKey, cleanBatchId, cleanSector, uid],
      );
      claimed = updated.rows.length;
      for (const row of updated.rows) {
        await client.query(
          `insert into ml_strategic_task_sector_events (task_id, setor, user_id, action, payload)
           values ($1,$2,$3,'sector_claimed',$4::jsonb)`,
          [row.task_id, row.setor, uid, JSON.stringify({ batch_id: cleanBatchId })],
        );
      }
      await client.query(
        `update ml_strategic_tasks t
            set status = 'in_progress',
                assigned_to_user_id = coalesce(assigned_to_user_id, $3),
                started_at = coalesce(started_at, now()),
                updated_at = now()
          where t.account_key = $1
            and t.task_batch_id = $2
            and t.status in ('pending','returned')
            and exists (
              select 1 from ml_strategic_task_sectors s
               where s.task_id = t.id
                 and s.setor = $4
                 and s.status = 'in_progress'
            )`,
        [resolvedAccountKey, cleanBatchId, uid, cleanSector],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
  return { success: true, claimed, blocked, sector: cleanSector };
}
async function recordTaskExecution({ accessToken = null, mlCreds = {}, accountKey, accountLabel = "", empresaId = null, taskId, user = {}, userId = null, actor = {}, materialsCreated = {}, materialLocations = {}, listingChanges = {}, materialsUnset = {}, listingUnset = {}, materialsNotApplicable = {}, listingNotApplicable = {}, materialsNotApplicableUnset = {}, listingNotApplicableUnset = {}, notes = "", statusAfter = "in_progress" } = {}) {
  const id = Number(taskId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Pendencia invalida.");
  const normalizedStatus = normalizeTaskStatus(statusAfter);
  if (!normalizedStatus || !["pending", "in_progress", "review"].includes(normalizedStatus)) throw new Error("Status de destino invalido.");
  const resolvedAccountKey = safeAccountKey(accountKey);
  const { rows } = await db.query(taskBaseSelect("where t.id = $1 and t.account_key = $2", "limit 1"), [id, resolvedAccountKey]);
  const task = rows[0];
  if (!task) throw new Error("Pendencia nao encontrada.");
  if (["completed", "canceled"].includes(task.status)) throw new Error("Esta pendencia ja foi finalizada.");
  const materials = normalizeBoolMap(materialsCreated, MATERIAL_KEYS);
  const changes = normalizeBoolMap(listingChanges, LISTING_CHANGE_KEYS);
  const unsetMaterials = normalizeBoolMap(materialsUnset, MATERIAL_KEYS);
  const unsetListings = normalizeBoolMap(listingUnset, LISTING_CHANGE_KEYS);
  const notApplicableMaterials = normalizeBoolMap(materialsNotApplicable, MATERIAL_KEYS);
  const notApplicableListings = normalizeBoolMap(listingNotApplicable, LISTING_CHANGE_KEYS);
  const unsetNotApplicableMaterials = normalizeBoolMap(materialsNotApplicableUnset, MATERIAL_KEYS);
  const unsetNotApplicableListings = normalizeBoolMap(listingNotApplicableUnset, LISTING_CHANGE_KEYS);
  if (![materials, changes, unsetMaterials, unsetListings, notApplicableMaterials, notApplicableListings, unsetNotApplicableMaterials, unsetNotApplicableListings].some(hasAnyTrue)) {
    throw new Error("Marque, desmarque ou defina ao menos uma atividade como nao se aplica.");
  }
  const permissionMatrix = await getStrategicPermissionMatrix(empresaId);
  const touchedSectors = sectorKeysForExecution(
    { ...materials, ...unsetMaterials, ...notApplicableMaterials, ...unsetNotApplicableMaterials },
    { ...changes, ...unsetListings, ...notApplicableListings, ...unsetNotApplicableListings },
    permissionMatrix,
    actor,
  );
  const payload = normalizeExecutionPayload(task.execution_payload);
  payload.entries.push(buildExecutionEntry({
    user,
    userId,
    materialsCreated: materials,
    listingChanges: changes,
    materialsUnset: unsetMaterials,
    listingUnset: unsetListings,
    materialsNotApplicable: notApplicableMaterials,
    listingNotApplicable: notApplicableListings,
    materialsNotApplicableUnset: unsetNotApplicableMaterials,
    listingNotApplicableUnset: unsetNotApplicableListings,
    materialLocations: mergeLatestMaterialLocations(payload.entries, materialLocations),
    notes,
    statusAfter: normalizedStatus,
    createsRound: false,
  }));
  const updates = ["status = $3", "execution_payload = $4::jsonb", "task_notes = coalesce($5, task_notes)", "updated_at = now()"];
  const params = [id, resolvedAccountKey, normalizedStatus, JSON.stringify(payload), String(notes || "").trim() || null];
  if (["in_progress", "review"].includes(normalizedStatus)) {
    params.push(normalizeUserSnapshot(user, userId).id);
    updates.push(`assigned_to_user_id = coalesce(assigned_to_user_id, $${params.length})`);
    updates.push("started_at = coalesce(started_at, now())");
  }
  const updated = await db.query(
    `update ml_strategic_tasks
        set ${updates.join(", ")}
      where id = $1
        and account_key = $2
      returning *`,
    params,
  );
  if (touchedSectors.length) {
    const completion = taskCompletionState({ ...task, execution_payload: payload }, {}, {}, { permissionMatrix });
    const completedSectors = touchedSectors.filter((sector) => !sectorHasMissingWork(sector, completion, permissionMatrix));
    if (completedSectors.length) {
      await markTaskSectors({ taskId: id, sectors: completedSectors, status: "completed", userId: normalizeUserSnapshot(user, userId).id, action: "sector_execution_recorded", note: notes, payload: { status_after: normalizedStatus } });
    }
    const incompleteSectors = touchedSectors.filter((sector) => !completedSectors.includes(sector));
    if (incompleteSectors.length) {
      await markTaskSectors({ taskId: id, sectors: incompleteSectors, status: "in_progress", userId: normalizeUserSnapshot(user, userId).id, action: "sector_progress_recorded", note: notes, payload: { status_after: normalizedStatus, missing: [...completion.missingMaterials, ...completion.missingListings] } });
    }
    await db.withClient(async (client) => {
      await syncTaskStatusFromSectors(client, id, normalizedStatus);
    });
  }
  const autoState = taskCompletionState({ ...task, execution_payload: payload }, {}, {}, { permissionMatrix });
  if (autoState.complete && hasAnyTrue(autoState.listingDone)) {
    try {
      const autoResult = await completeTask({
        accessToken,
        mlCreds,
        accountKey: resolvedAccountKey,
        accountLabel: accountLabel || task.account_label,
        empresaId,
        taskId: id,
        user,
        userId,
        actor: { isAdmin: true, sectors: [] },
        materialsCreated: autoState.materialDone,
        materialLocations: mergeLatestMaterialLocations(payload.entries, materialLocations),
        listingChanges: autoState.listingDone,
        changeNotes: String(notes || "").trim() || task.task_notes || "",
        alterationDate: task.effective_analysis_start_date || task.analysis_start_date || currentDateSaoPaulo(),
        windowDays: DEFAULT_WINDOW_DAYS,
      });
      return { ...autoResult, auto_completed: true, auto_ready: true };
    } catch (error) {
      const fresh = await db.query(taskBaseSelect("where t.id = $1 and t.account_key = $2", "limit 1"), [id, resolvedAccountKey]);
      return {
        success: true,
        task: mapTaskRow(fresh.rows[0] || updated.rows[0]),
        auto_completed: false,
        auto_ready: true,
        auto_error: error?.message || "Falha ao iniciar monitoramento automaticamente.",
        completion: {
          complete: autoState.complete,
          missing_materials: autoState.missingMaterials || [],
          missing_listings: autoState.missingListings || [],
        },
      };
    }
  }
  const fresh = await db.query(taskBaseSelect("where t.id = $1 and t.account_key = $2", "limit 1"), [id, resolvedAccountKey]);
  return {
    success: true,
    task: mapTaskRow(fresh.rows[0] || updated.rows[0]),
    auto_completed: false,
    auto_ready: false,
    completion: {
      complete: autoState.complete,
      missing_materials: autoState.missingMaterials || [],
      missing_listings: autoState.missingListings || [],
    },
  };
}
async function returnTaskMaterials({ accountKey, empresaId = null, taskId, user = {}, userId = null, actor = {}, materials = {}, reason = "", note = "" } = {}) {
  const id = Number(taskId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Pendencia invalida.");
  const normalizedActor = normalizeActor(actor);
  if (!normalizedActor.isAdmin && !normalizedActor.sectors.length) {
    const error = new Error("Seu usuario ainda nao possui setor atribuido para devolver materiais.");
    error.statusCode = 403;
    throw error;
  }
  const returnedMaterials = normalizeBoolMap(materials, MATERIAL_KEYS);
  if (!hasAnyTrue(returnedMaterials)) throw new Error("Selecione fotos, clips ou ambos para devolver.");
  const cleanReason = String(reason || "").trim().slice(0, 500);
  const cleanNote = String(note || "").trim().slice(0, 1000);
  if (!cleanReason) throw new Error("Informe o motivo da devolucao.");
  const resolvedAccountKey = safeAccountKey(accountKey);
  const { rows } = await db.query(taskBaseSelect("where t.id = $1 and t.account_key = $2", "limit 1"), [id, resolvedAccountKey]);
  const task = rows[0];
  if (!task) throw new Error("Pendencia nao encontrada.");
  if (["completed", "canceled"].includes(task.status)) throw new Error("Esta pendencia ja foi finalizada.");

  let integrationSync = { attempted: false, results: [] };
  await db.withClient(async (client) => {
    await client.query("begin");
    try {
      const locked = await client.query(`select id, execution_payload from ml_strategic_tasks where id = $1 and account_key = $2 for update`, [id, resolvedAccountKey]);
      const lockedTask = locked.rows[0];
      if (!lockedTask) throw new Error("Pendencia nao encontrada.");
      const payload = normalizeExecutionPayload(lockedTask.execution_payload);
      payload.entries.push(buildMaterialReturnExecutionEntry({
        user,
        userId,
        materials: returnedMaterials,
        reason: cleanReason,
        note: cleanNote,
      }));
      await client.query(
        `update ml_strategic_tasks
            set status = 'returned',
                execution_payload = $3::jsonb,
                task_notes = $4,
                completed_at = null,
                completed_by_user_id = null,
                updated_at = now()
          where id = $1
            and account_key = $2`,
        [id, resolvedAccountKey, JSON.stringify(payload), cleanNote || cleanReason],
      );
      await client.query(
        `update ml_strategic_task_sectors
            set status = 'returned',
                completed_at = null,
                updated_at = now()
          where task_id = $1
            and setor = 'marketing'
            and status <> 'canceled'`,
        [id],
      );
      await client.query(
        `insert into ml_strategic_task_sector_events (task_id, setor, user_id, action, note, payload)
         values ($1,'marketing',$2,'materials_returned',$3,$4::jsonb)`,
        [
          id,
          normalizeUserSnapshot(user, userId).id,
          cleanNote || cleanReason,
          JSON.stringify({ materials: returnedMaterials, reason: cleanReason }),
        ],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });

  try {
    integrationSync = await CompanyIntegrationsService.sendStrategicTaskReturn({
      taskId: id,
      materials: returnedMaterials,
      reason: cleanReason,
      note: cleanNote,
      user: normalizeUserSnapshot(user, userId),
    });
  } catch (error) {
    integrationSync = { attempted: true, results: [{ provider: "markflow", sent: 0, error: error?.message || "Falha ao devolver para integracao." }] };
  }

  if (integrationSync.attempted) {
    await db.query(
      `update ml_strategic_tasks
          set execution_payload = jsonb_set(
                coalesce(execution_payload, '{"entries":[]}'::jsonb),
                '{entries,-1,integration_sync}',
                $3::jsonb,
                true
              ),
              updated_at = now()
        where id = $1
          and account_key = $2`,
      [id, resolvedAccountKey, JSON.stringify(integrationSync)],
    );
  }

  const fresh = await db.query(taskBaseSelect("where t.id = $1 and t.account_key = $2", "limit 1"), [id, resolvedAccountKey]);
  return { success: true, task: mapTaskRow(fresh.rows[0]), integration_sync: integrationSync };
}
function mapWatchlistRow(row = {}) {
  const listingBadges = normalizeListingBadges(row?.base_metrics?.listing_badges || {});
  const watchlistTags = uniqueTaskTags(row?.base_metrics?.watchlist_tags || []);
  const watchlistTagColors = normalizeTaskTagColorsMap(row?.base_metrics?.watchlist_tag_colors || {}, watchlistTags);
  return {
    id: String(row.id),
    item_id: row.item_id ? String(row.item_id) : null,
    account_key: row.account_key,
    account_label: row.account_label || null,
    mlb: row.mlb,
    sku: row.sku || row.item_sku || null,
    title: row.title_snapshot || row.item_title || row.mlb,
    thumbnail: row.thumbnail_snapshot || row.item_thumbnail || null,
    permalink: row.item_permalink || null,
    price: Number.isFinite(Number(row.item_price)) ? Number(row.item_price) : null,
    stock: Number.isFinite(Number(row.item_stock)) ? Number(row.item_stock) : null,
    listing_status: row.item_status || null,
    listing_badges: listingBadges,
    reason: row.reason || "",
    notes: row.notes || "",
    status: row.status || "tracking",
    base_metrics: row.base_metrics || {},
    watchlist_tags: watchlistTags,
    watchlist_tag_colors: watchlistTagColors,
    action_flags: normalizeChangeFlags(row.action_flags || {}),
    last_action_at: row.last_action_at || null,
    open_task_id: row.open_task_id ? String(row.open_task_id) : null,
    open_task_status: row.open_task_status || null,
    open_task_batch_name: row.open_task_batch_name || null,
    latest_event: row.latest_event || null,
    round_impact: row.latest_round_impact || null,
    created_by: row.created_by_user_id ? { id: String(row.created_by_user_id), name: row.created_by_nome || row.created_by_email || null, email: row.created_by_email || null } : null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}
function watchlistBaseSelect(whereSql = "", orderSql = "order by w.updated_at desc, w.id desc") {
  return `select w.*,
                 i.sku as item_sku,
                 i.title as item_title,
                 i.thumbnail as item_thumbnail,
                 i.status as item_status,
                 i.price as item_price,
                 i.stock as item_stock,
                 i.permalink as item_permalink,
                 cu.nome as created_by_nome,
                 cu.email as created_by_email,
                 ot.id as open_task_id,
                 ot.status as open_task_status,
                 ot.task_batch_name as open_task_batch_name,
                 le.event as latest_event,
                 lr.impact as latest_round_impact
            from ml_strategic_watchlist w
            left join ml_strategic_items i on i.id = w.item_id
            left join usuarios cu on cu.id = w.created_by_user_id
            left join lateral (
              select t.id, t.status, t.task_batch_name
                from ml_strategic_tasks t
               where t.account_key = w.account_key
                 and t.mlb = w.mlb
                 and t.status in ('pending','in_progress','review','returned')
               order by t.created_at desc, t.id desc
               limit 1
            ) ot on true
            left join lateral (
              select jsonb_build_object(
                       'id', e.id::text,
                       'type', e.event_type,
                       'action_flags', e.action_flags,
                       'hypothesis', e.hypothesis,
                       'notes', e.notes,
                       'primary_metric', e.primary_metric,
                       'window_days', e.window_days,
                       'occurred_on', e.occurred_on,
                       'created_at', e.created_at
                     ) as event
                from ml_strategic_watchlist_events e
               where e.watchlist_id = w.id
               order by e.created_at desc, e.id desc
               limit 1
            ) le on true
            left join lateral (
              select r.impact
                from ml_strategic_rounds r
               where r.account_key = w.account_key
                 and r.mlb = w.mlb
                 and r.task_batch_id is null
                 and r.source_task_id is null
               order by coalesce(r.reviewed_at, r.created_at) desc, r.id desc
               limit 1
            ) lr on true
            ${whereSql}
            ${orderSql}`;
}
async function completeTask({ accessToken, mlCreds = {}, accountKey, accountLabel, empresaId = null, taskId, user = {}, userId = null, actor = {}, changeFlags = null, changeNotes = "", materialsCreated = {}, materialLocations = {}, listingChanges = null, materialsNotApplicable = {}, listingNotApplicable = {}, alterationDate = null, windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const id = Number(taskId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Pendencia invalida.");
  const resolvedAccountKey = safeAccountKey(accountKey || mlCreds?.meli_conta_id || mlCreds?.id || mlCreds?.meli_user_id);
  const { rows } = await db.query(taskBaseSelect("where t.id = $1 and t.account_key = $2", "limit 1"), [id, resolvedAccountKey]);
  const task = rows[0];
  if (!task) throw new Error("Pendencia nao encontrada.");
  if (task.status === "completed") return { success: true, task: mapTaskRow(task), already_completed: true };
  const normalizedListingChanges = normalizeBoolMap(listingChanges && typeof listingChanges === "object" ? listingChanges : {}, LISTING_CHANGE_KEYS);
  const taskFlags = normalizeChangeFlags(task.task_flags || {});
  const submittedFlags = listingChangesToLegacyFlags(normalizedListingChanges);
  const explicitFlags = changeFlags && typeof changeFlags === "object" ? normalizeChangeFlags(changeFlags) : {};
  const flags = normalizeChangeFlags({
    ...taskFlags,
    ...submittedFlags,
    ...explicitFlags,
  });
  if (!hasAnyTrue(flags)) throw new Error("Marque ao menos uma alteracao publicada no anuncio para monitorar.");
  const normalizedMaterials = normalizeBoolMap(materialsCreated, MATERIAL_KEYS);
  const normalizedMaterialsNotApplicable = normalizeBoolMap(materialsNotApplicable, MATERIAL_KEYS);
  const normalizedListingsNotApplicable = normalizeBoolMap(listingNotApplicable, LISTING_CHANGE_KEYS);
  const permissionMatrix = await getStrategicPermissionMatrix(empresaId);
  const completedSectors = sectorKeysForExecution(normalizedMaterials, hasAnyTrue(normalizedListingChanges) ? normalizedListingChanges : {
    photos: !!flags.photo,
    clips_video: !!flags.clips,
    title: !!flags.title,
    description: !!flags.description,
    attributes: !!flags.attributes,
    model: !!flags.model,
    lead_time: !!flags.lead_time,
    price: !!flags.price,
    stock: !!flags.stock,
    promotion: !!flags.promotion,
    ads: !!flags.ads,
    shipping: !!flags.shipping,
    other: !!flags.other,
  }, permissionMatrix, actor);
  const pendingFinalizeSectors = normalizeSectorRows(task.sectors)
    .filter((sector) => !["completed", "canceled"].includes(String(sector.status || "pending")))
    .map((sector) => sector.key || sector.setor);
  assertActorCanUseSectors(actor, pendingFinalizeSectors.length ? pendingFinalizeSectors : completedSectors, "Este usuario nao possui setor liberado para finalizar estas alteracoes.");
  const completion = taskCompletionState(task, normalizedMaterials, normalizedListingChanges, {
    permissionMatrix,
    notApplicable: { materials: normalizedMaterialsNotApplicable, listings: normalizedListingsNotApplicable },
  });
  if (!completion.complete) {
    const error = new Error(missingTaskWorkMessage(completion) || "Ainda faltam etapas obrigatorias antes de iniciar o monitoramento.");
    error.statusCode = 400;
    error.details = { missing_materials: completion.missingMaterials, missing_listings: completion.missingListings };
    throw error;
  }
  const notes = String(changeNotes || "").trim() || task.task_notes || "";
  const actualFlags = listingChangesToLegacyFlags(normalizedListingChanges);
  const hasActualListingChange = hasAnyTrue(normalizedListingChanges);
  const roundResult = hasActualListingChange ? await createRounds({
    accessToken,
    mlCreds,
    accountKey: resolvedAccountKey,
    accountLabel: accountLabel || task.account_label,
    items: [{ mlb: task.mlb, id: task.mlb, sku: task.sku, title: task.title_snapshot, thumbnail: task.thumbnail_snapshot, account_label: task.account_label }],
    groupId: task.group_id || null,
    sourceTaskId: task.id,
    taskBatchId: task.task_batch_id || null,
    taskBatchName: task.task_batch_name || null,
    changeFlags: actualFlags,
    changeNotes: notes,
    alterationDate: alterationDate || task.effective_analysis_start_date || task.analysis_start_date || currentDateSaoPaulo(),
    windowDays,
  }) : { success: true, rows: [] };
  const createdRoundId = roundResult.rows?.[0]?.id ? Number(roundResult.rows[0].id) : null;
  const payload = normalizeExecutionPayload(task.execution_payload);
  payload.entries.push(buildExecutionEntry({
    user,
    userId,
    materialsCreated,
    listingChanges: hasAnyTrue(normalizedListingChanges) ? normalizedListingChanges : {
      photos: false,
      clips_video: false,
      title: false,
      description: false,
      attributes: false,
      model: false,
      lead_time: false,
      price: false,
      stock: false,
      promotion: false,
      ads: false,
      shipping: false,
      other: false,
    },
    materialsNotApplicable: normalizedMaterialsNotApplicable,
    listingNotApplicable: normalizedListingsNotApplicable,
    materialLocations: mergeLatestMaterialLocations(payload.entries, materialLocations),
    notes,
    statusAfter: "completed",
    createsRound: !!createdRoundId,
    roundId: createdRoundId,
  }));
  const updated = await db.query(
    `update ml_strategic_tasks
        set status = 'completed',
            completed_by_user_id = $3,
            completed_at = now(),
            assigned_to_user_id = coalesce(assigned_to_user_id, $3),
            started_at = coalesce(started_at, now()),
            task_flags = $4::jsonb,
            task_notes = $5,
            created_round_id = $6,
            execution_payload = $7::jsonb,
            updated_at = now()
      where id = $1
        and account_key = $2
      returning *`,
    [id, resolvedAccountKey, normalizeUserSnapshot(user, userId).id, JSON.stringify(normalizeChangeFlags(flags)), notes || null, createdRoundId, JSON.stringify(payload)],
  );
  const allSectors = await db.query("select setor from ml_strategic_task_sectors where task_id = $1", [id]);
  await markTaskSectors({ taskId: id, sectors: allSectors.rows.map((row) => row.setor), status: "completed", userId: normalizeUserSnapshot(user, userId).id, action: "task_completed", note: notes, payload: { round_id: createdRoundId } });
  await db.query(
    `update ml_strategic_round_task_reviews
        set status = 'resolved',
            resolved_at = now(),
            updated_at = now()
      where task_id = $1
        and status = 'open'`,
    [id],
  );
  const fresh = await db.query(taskBaseSelect("where t.id = $1 and t.account_key = $2", "limit 1"), [id, resolvedAccountKey]);
  return { success: true, task: mapTaskRow(fresh.rows[0] || updated.rows[0]), round: roundResult.rows?.[0] || null, completed_without_monitoring: !createdRoundId };
}
async function loadCredsForAccountKey(accountKey) {
  const accountId = Number(accountKey);
  if (!Number.isFinite(accountId) || accountId <= 0) throw new Error("Conta sem meli_conta_id numerico para revisao automatica.");
  const { rows } = await db.query(`select mc.id, mc.apelido, mc.meli_user_id, mc.site_id, mt.access_token, mt.access_expires_at, mt.refresh_token, mt.scope from meli_contas mc join meli_tokens mt on mt.meli_conta_id = mc.id where mc.id = $1 limit 1`, [accountId]);
  const account = rows[0];
  if (!account) throw new Error(`Conta ML ${accountId} nao encontrada para revisao automatica.`);
  return {
    app_id: process.env.ML_APP_ID || process.env.APP_ID || process.env.CLIENT_ID || process.env.MERCADOLIBRE_APP_ID || null,
    client_secret: process.env.ML_CLIENT_SECRET || process.env.CLIENT_SECRET || process.env.MERCADOLIBRE_CLIENT_SECRET || null,
    redirect_uri: process.env.ML_REDIRECT_URI || process.env.REDIRECT_URI || process.env.MERCADOLIBRE_REDIRECT_URI || null,
    meli_conta_id: account.id,
    account_key: String(account.id),
    accountKey: String(account.id),
    meli_user_id: account.meli_user_id,
    site_id: account.site_id || "MLB",
    access_token: account.access_token ? decryptToken(account.access_token) : null,
    refresh_token: account.refresh_token ? decryptToken(account.refresh_token) : null,
    access_expires_at: account.access_expires_at || null,
    scope: account.scope || null,
  };
}
async function reviewRound({ roundId, accessToken = null, mlCreds = null, force = false } = {}) {
  const { rows } = await db.query(`select r.*, i.permalink, i.thumbnail as item_thumbnail from ml_strategic_rounds r left join ml_strategic_items i on i.id = r.item_id where r.id = $1`, [roundId]);
  const round = rows[0];
  if (!round) throw new Error("Rodada estrategica nao encontrada.");
  if (round.status === "interrupted") return { success: true, round: mapRoundRow(round), skipped: true };
  let creds = mlCreds;
  if (!accessToken && !creds) creds = await loadCredsForAccountKey(round.account_key);
  const state = await prepareAuthState({ accessToken, mlCreds: creds || {} });
  const sellerId = round.seller_id || (await getSellerId(state, creds || {}));
  const yesterday = addDays(currentDateSaoPaulo(), -1);
  const plannedAfterTo = toYmd(round.after_to);
  const afterTo = plannedAfterTo && plannedAfterTo < yesterday ? plannedAfterTo : yesterday;
  const afterFrom = toYmd(round.after_from);
  const afterComplete = force || (plannedAfterTo && plannedAfterTo <= yesterday);
  const afterMetrics = afterFrom && afterTo && afterFrom <= afterTo ? await captureMetrics({ state, sellerId, mlb: round.mlb, from: afterFrom, to: afterTo }) : emptyMetrics(afterFrom, afterTo);
  const beforeMetrics = round.before_metrics || emptyMetrics(round.before_from, round.before_to);
  const deltas = buildDeltas(beforeMetrics, afterMetrics);
  const statusInfo = classifyComparison(beforeMetrics, afterMetrics, afterComplete);
  const insights = buildRoundInsights({ ...round, after_metrics: afterMetrics, deltas, impact: statusInfo.impact, confidence: statusInfo.confidence });
  const newStatus = afterComplete ? "completed" : "ready";
  const updated = await db.query(
    `update ml_strategic_rounds set status = $2, impact = $3, confidence = $4, after_metrics = $5::jsonb, deltas = $6::jsonb, insights = $7::jsonb, error = null, reviewed_at = now(), updated_at = now() where id = $1 returning *`,
    [round.id, newStatus, statusInfo.impact, statusInfo.confidence, JSON.stringify(afterMetrics), JSON.stringify(deltas), JSON.stringify(insights)],
  );
  return { success: true, round: mapRoundRow(updated.rows[0]), after_complete: afterComplete };
}
async function returnRoundToTask({ accountKey, empresaId = null, roundId, user = {}, userId = null, actor = {}, reason = "", reopenFlags = {} } = {}) {
  if (!normalizeActor(actor).isAdmin) {
    const error = new Error("Apenas administradores podem devolver um monitoramento para a lista de tarefas.");
    error.statusCode = 403;
    throw error;
  }
  const id = Number(roundId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Monitoramento invalido.");
  const cleanReason = String(reason || "").trim().slice(0, 500);
  if (!cleanReason) throw new Error("Informe o motivo da devolucao.");
  const resolvedAccountKey = safeAccountKey(accountKey);
  const normalizedReopenFlags = normalizeChangeFlags(reopenFlags);
  if (!hasAnyTrue(normalizedReopenFlags)) throw new Error("Selecione ao menos uma alteracao para voltar para revisao.");
  let taskId = null;
  let reviewId = null;
  await db.withClient(async (client) => {
    await client.query("begin");
    try {
      const { rows } = await client.query(
        `select *
           from ml_strategic_rounds
          where id = $1
            and account_key = $2
          limit 1`,
        [id, resolvedAccountKey],
      );
      const round = rows[0];
      if (!round) throw new Error("Monitoramento nao encontrado.");
      if (!round.source_task_id) throw new Error("Este monitoramento nao possui tarefa de origem para devolver.");
      taskId = Number(round.source_task_id);
      const taskResult = await client.query(taskBaseSelect("where t.id = $1 and t.account_key = $2", "limit 1"), [taskId, resolvedAccountKey]);
      const task = taskResult.rows[0];
      if (!task) throw new Error("Tarefa de origem nao encontrada.");
      const snapshot = normalizeUserSnapshot(user, userId);
      const reviewResult = await client.query(
        `insert into ml_strategic_round_task_reviews
           (round_id, task_id, account_key, mlb, reopen_flags, reason, status, requested_by_user_id)
         values ($1,$2,$3,$4,$5::jsonb,$6,'open',$7)
         returning id`,
        [id, taskId, resolvedAccountKey, round.mlb, JSON.stringify(normalizedReopenFlags), cleanReason, snapshot.id],
      );
      reviewId = reviewResult.rows?.[0]?.id || null;
      const payload = normalizeExecutionPayload(task.execution_payload);
      payload.entries.push(buildReopenExecutionEntry({ user, userId, reopenFlags: normalizedReopenFlags, notes: cleanReason, roundId: id, reviewId }));
      const mergedFlags = normalizeChangeFlags({ ...(task.task_flags || {}), ...normalizedReopenFlags });
      await client.query(
        `update ml_strategic_tasks
            set status = 'returned',
                completed_at = null,
                completed_by_user_id = null,
                task_flags = $3::jsonb,
                execution_payload = $4::jsonb,
                task_notes = $5,
                updated_at = now()
          where id = $1
            and account_key = $2`,
        [taskId, resolvedAccountKey, JSON.stringify(mergedFlags), JSON.stringify(payload), cleanReason],
      );
      const permissionMatrix = await getStrategicPermissionMatrix(empresaId);
      const listingChanges = listingChangesFromLegacyFlags(normalizedReopenFlags);
      const reopenSectors = sectorKeysForExecution({}, listingChanges, permissionMatrix, { isAdmin: true, sectors: [] });
      const sectors = reopenSectors.length ? reopenSectors : ["cadastro"];
      for (const setor of sectors) {
        await client.query(
          `insert into ml_strategic_task_sectors (task_id, setor, label, status, updated_at)
           values ($1,$2,$3,'pending',now())
           on conflict (task_id, setor)
           do update set status = 'pending',
                         completed_at = null,
                         updated_at = now()`,
          [taskId, setor, sectorLabelFromKey(setor)],
        );
      }
      await client.query(
        `update ml_strategic_task_sectors
            set status = case when status = 'completed' and setor = any($2::text[]) then 'pending' else status end,
                completed_at = null,
                updated_at = now()
          where task_id = $1
            and status <> 'canceled'
            and setor = any($2::text[])`,
        [taskId, sectors],
      );
      await client.query(
        `insert into ml_strategic_task_sector_events (task_id, setor, user_id, action, note, payload)
         values ($1,null,$2,'round_returned_to_task',$3,$4::jsonb)`,
        [taskId, snapshot.id, cleanReason, JSON.stringify({ round_id: String(id), review_id: reviewId ? String(reviewId) : null, reopen_flags: normalizedReopenFlags })],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
  const fresh = await db.query(taskBaseSelect("where t.id = $1 and t.account_key = $2", "limit 1"), [taskId, resolvedAccountKey]);
  return { success: true, task: mapTaskRow(fresh.rows[0]), round_id: String(id), review_id: reviewId ? String(reviewId) : null };
}
async function reviewDueRounds({ limit = 50 } = {}) {
  const today = currentDateSaoPaulo();
  const lock = await db.query(`select pg_try_advisory_lock(hashtext($1)) as locked`, ["ml_strategic_due_reviews"]);
  if (!lock.rows?.[0]?.locked) return { success: true, skipped: true, reason: "lock_not_acquired" };
  try {
    const { rows } = await db.query(`select id from ml_strategic_rounds where status in ('active','ready') and review_due_date <= $1::date order by review_due_date asc, id asc limit $2`, [today, Math.max(1, Math.min(200, Number(limit) || 50))]);
    const output = [];
    for (const row of rows) {
      try {
        const result = await reviewRound({ roundId: row.id });
        output.push({ id: String(row.id), ok: true, impact: result.round?.impact || null });
      } catch (error) {
        await db.query(`update ml_strategic_rounds set status = 'failed', impact = 'failed', confidence = 'low', error = $2, updated_at = now() where id = $1`, [row.id, error?.message || String(error)]);
        output.push({ id: String(row.id), ok: false, error: error?.message || String(error) });
      }
    }
    return { success: true, checked_date: today, total: rows.length, rows: output };
  } finally {
    await db.query(`select pg_advisory_unlock(hashtext($1))`, ["ml_strategic_due_reviews"]).catch(() => null);
  }
}
function csvEscape(value) {
  const text = value == null ? "" : String(value);
  if (!/[";\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

const REPORT_MATERIAL_LABELS = { photos: "Fotos novas", clips_video: "Clips/videos novos" };
const REPORT_LISTING_LABELS = {
  photos: "Fotos publicadas",
  clips_video: "Clips/videos publicados",
  title: "Titulo",
  description: "Descricao",
  attributes: "Ficha tecnica",
  model: "Modelo",
  lead_time: "Prazo de producao",
  price: "Preco",
  stock: "Estoque",
  promotion: "Promocao",
  ads: "Ads",
  shipping: "Frete",
  other: "Outro ajuste",
};
const REPORT_STATUS_LABELS = {
  pending: "Pendente",
  in_progress: "Em andamento",
  review: "Em revisao",
  returned: "Devolvida",
  completed: "Concluida",
  canceled: "Cancelada",
};
const REPORT_PRIORITY_LABELS = { high: "Alta", medium: "Media", low: "Baixa" };

function firstDayOfCurrentMonth() {
  return currentDateSaoPaulo().slice(0, 8) + "01";
}
function reportDateRange(from = null, to = null) {
  let dateFrom = toYmd(from) || firstDayOfCurrentMonth();
  let dateTo = toYmd(to) || currentDateSaoPaulo();
  if (dateTo < dateFrom) [dateFrom, dateTo] = [dateTo, dateFrom];
  return { dateFrom, dateTo };
}
function reportBooleanLabels(map = {}, labels = {}) {
  return Object.entries(labels)
    .filter(([key]) => map?.[key] === true || map?.[key] === "true")
    .map(([, label]) => label);
}
function reportFlagCounts(target = {}, keys = []) {
  for (const key of keys) target[key] = Number(target[key] || 0) + 1;
}
function normalizeReportStatus(value = "") {
  const clean = String(value || "").trim().toLowerCase();
  if (!clean || clean === "all") return "";
  return ["pending", "in_progress", "review", "returned", "completed", "canceled", "open"].includes(clean) ? clean : "";
}
function taskReportFilename(accountLabel = "") {
  const safe = String(accountLabel || "conta")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "conta";
  return `relatorio-tarefas-estrategicas-${safe}-${currentDateSaoPaulo()}.xlsx`;
}
function setWorksheetColumns(worksheet, rows = []) {
  const source = rows.length ? rows : XLSX.utils.sheet_to_json(worksheet, { header: 1 });
  const widths = [];
  source.forEach((row) => {
    const values = Array.isArray(row) ? row : Object.values(row || {});
    values.forEach((value, index) => {
      const len = String(value == null ? "" : value).length;
      widths[index] = Math.max(widths[index] || 10, Math.min(48, len + 2));
    });
  });
  worksheet["!cols"] = widths.map((wch) => ({ wch: Math.max(12, wch || 12) }));
}

async function listTaskReportOptions({ accountKey } = {}) {
  const resolvedAccountKey = safeAccountKey(accountKey);
  const [usersResult, batchesResult, sectorsResult] = await Promise.all([
    db.query(
      `with involved as (
         select assigned_to_user_id as user_id from ml_strategic_tasks where account_key = $1 and assigned_to_user_id is not null
         union
         select completed_by_user_id from ml_strategic_tasks where account_key = $1 and completed_by_user_id is not null
         union
         select canceled_by_user_id from ml_strategic_tasks where account_key = $1 and canceled_by_user_id is not null
         union
         select nullif(entry ->> 'user_id', '')::bigint as user_id
           from ml_strategic_tasks t
           cross join lateral jsonb_array_elements(coalesce(t.execution_payload -> 'entries', '[]'::jsonb)) entry
          where t.account_key = $1
            and nullif(entry ->> 'user_id', '') ~ '^[0-9]+$'
       )
       select u.id, u.nome, u.email
         from involved i
         join usuarios u on u.id = i.user_id
        group by u.id, u.nome, u.email
        order by coalesce(u.nome, u.email) asc`,
      [resolvedAccountKey],
    ),
    db.query(
      `select id, name, status
         from ml_strategic_task_batches
        where account_key = $1
        order by updated_at desc, name asc
        limit 300`,
      [resolvedAccountKey],
    ),
    db.query(
      `select s.setor as key, max(s.label) as label
         from ml_strategic_task_sectors s
         join ml_strategic_tasks t on t.id = s.task_id
        where t.account_key = $1
        group by s.setor
        order by max(s.label) asc`,
      [resolvedAccountKey],
    ),
  ]);
  return {
    success: true,
    users: usersResult.rows.map((row) => ({ id: String(row.id), name: row.nome || row.email || `Usuario ${row.id}`, email: row.email || null })),
    batches: batchesResult.rows.map((row) => ({ id: row.id, name: row.name || `Lote #${row.id}`, status: row.status || "active" })),
    sectors: sectorsResult.rows.map((row) => ({ key: row.key, label: row.label || sectorLabelFromKey(row.key) })),
  };
}

async function buildTaskReportWorkbook({ accountKey, accountLabel = "", dateFrom = null, dateTo = null, userId = "", sector = "", batchId = "", status = "" } = {}) {
  const resolvedAccountKey = safeAccountKey(accountKey);
  const range = reportDateRange(dateFrom, dateTo);
  const params = [resolvedAccountKey, range.dateFrom, range.dateTo];
  const filters = [
    "t.account_key = $1",
    `(
      (t.created_at at time zone 'America/Sao_Paulo')::date between $2::date and $3::date
      or (t.completed_at at time zone 'America/Sao_Paulo')::date between $2::date and $3::date
      or (t.canceled_at at time zone 'America/Sao_Paulo')::date between $2::date and $3::date
      or exists (
        select 1
          from jsonb_array_elements(coalesce(t.execution_payload -> 'entries', '[]'::jsonb)) entry
         where ((entry ->> 'at')::timestamptz at time zone 'America/Sao_Paulo')::date between $2::date and $3::date
      )
    )`,
  ];
  const normalizedStatus = normalizeReportStatus(status);
  if (normalizedStatus === "open") {
    filters.push("t.status in ('pending','in_progress','review','returned')");
  } else if (normalizedStatus) {
    params.push(normalizedStatus);
    filters.push(`t.status = $${params.length}`);
  }
  const cleanBatchId = String(batchId || "").trim();
  if (cleanBatchId) {
    params.push(cleanBatchId);
    filters.push(`t.task_batch_id = $${params.length}`);
  }
  const cleanSector = sectorKey(sector);
  if (cleanSector) {
    params.push(cleanSector);
    filters.push(`exists (select 1 from ml_strategic_task_sectors sx where sx.task_id = t.id and sx.setor = $${params.length})`);
  }
  const numericUserId = Number(userId);
  if (Number.isFinite(numericUserId) && numericUserId > 0) {
    params.push(numericUserId);
    const p = `$${params.length}`;
    filters.push(`(
      t.assigned_to_user_id = ${p}
      or t.completed_by_user_id = ${p}
      or t.canceled_by_user_id = ${p}
      or exists (select 1 from ml_strategic_task_sectors su where su.task_id = t.id and su.assigned_user_id = ${p})
      or exists (
        select 1
          from jsonb_array_elements(coalesce(t.execution_payload -> 'entries', '[]'::jsonb)) entry
         where nullif(entry ->> 'user_id', '') ~ '^[0-9]+$'
           and nullif(entry ->> 'user_id', '')::bigint = ${p}
      )
    )`);
  }
  const whereSql = `where ${filters.join(" and ")}`;
  const taskResult = await db.query(
    `select t.id,
            t.mlb,
            t.sku,
            t.title_snapshot,
            t.status,
            t.priority,
            t.task_flags,
            t.task_notes,
            t.due_date,
            t.analysis_start_date,
            t.created_at,
            t.started_at,
            t.completed_at,
            t.canceled_at,
            t.cancel_reason,
            t.task_batch_id,
            coalesce(b.name, t.task_batch_name, 'Sem lote') as batch_name,
            coalesce(b.tags, '{}'::text[]) as batch_tags,
            coalesce(string_agg(distinct s.label, ', ') filter (where s.id is not null), '') as sectors,
            coalesce(string_agg(distinct sau.nome, ', ') filter (where sau.id is not null), '') as sector_responsibles,
            cu.nome as created_by_name,
            au.nome as assigned_to_name,
            cbu.nome as completed_by_name,
            x.execution_payload
       from ml_strategic_tasks t
       left join ml_strategic_task_batches b on b.id = t.task_batch_id and b.account_key = t.account_key
       left join ml_strategic_task_sectors s on s.task_id = t.id
       left join usuarios sau on sau.id = s.assigned_user_id
       left join usuarios cu on cu.id = t.created_by_user_id
       left join usuarios au on au.id = t.assigned_to_user_id
       left join usuarios cbu on cbu.id = t.completed_by_user_id
       cross join lateral (select coalesce(t.execution_payload, '{"entries":[]}'::jsonb) as execution_payload) x
      ${whereSql}
      group by t.id, b.name, b.tags, cu.nome, au.nome, cbu.nome, x.execution_payload
      order by coalesce(t.completed_at, t.updated_at, t.created_at) desc, t.id desc`,
    params,
  );
  const activityResult = await db.query(
    `select t.id as task_id,
            t.mlb,
            t.sku,
            t.title_snapshot,
            t.status,
            t.priority,
            t.due_date,
            t.analysis_start_date,
            t.created_at as task_created_at,
            t.completed_at,
            t.task_batch_id,
            coalesce(b.name, t.task_batch_name, 'Sem lote') as batch_name,
            coalesce(b.tags, '{}'::text[]) as batch_tags,
            coalesce(string_agg(distinct s.label, ', ') filter (where s.id is not null), '') as sectors,
            coalesce(string_agg(distinct su.nome, ', ') filter (where su.id is not null), '') as user_sectors,
            entry
       from ml_strategic_tasks t
       left join ml_strategic_task_batches b on b.id = t.task_batch_id and b.account_key = t.account_key
       left join ml_strategic_task_sectors s on s.task_id = t.id
       cross join lateral jsonb_array_elements(coalesce(t.execution_payload -> 'entries', '[]'::jsonb)) entry
       left join ml_strategic_task_sectors us on us.task_id = t.id and nullif(entry ->> 'user_id', '') ~ '^[0-9]+$' and us.assigned_user_id = nullif(entry ->> 'user_id', '')::bigint
       left join usuarios su on su.id = us.assigned_user_id
      ${whereSql}
        and ((entry ->> 'at')::timestamptz at time zone 'America/Sao_Paulo')::date between $2::date and $3::date
      group by t.id, b.name, b.tags, entry
      order by ((entry ->> 'at')::timestamptz) desc, t.id desc`,
    params,
  );

  const tasks = taskResult.rows || [];
  const activities = activityResult.rows || [];
  const summaryByUser = new Map();
  const detailRows = activities.map((row) => {
    const entry = row.entry || {};
    const materials = normalizeBoolMap(entry.materials_created || {}, MATERIAL_KEYS);
    const changes = normalizeBoolMap(entry.listing_changes || {}, LISTING_CHANGE_KEYS);
    const returnedMaterials = normalizeBoolMap(entry.materials_returned || entry.materials_unset || {}, MATERIAL_KEYS);
    const notApplicableMaterials = normalizeBoolMap(entry.materials_not_applicable || {}, MATERIAL_KEYS);
    const notApplicableListings = normalizeBoolMap(entry.listing_not_applicable || {}, LISTING_CHANGE_KEYS);
    const materialLabels = reportBooleanLabels(materials, REPORT_MATERIAL_LABELS);
    const changeLabels = reportBooleanLabels(changes, REPORT_LISTING_LABELS);
    const returnedLabels = reportBooleanLabels(returnedMaterials, REPORT_MATERIAL_LABELS);
    const notApplicableLabels = [
      ...reportBooleanLabels(notApplicableMaterials, REPORT_MATERIAL_LABELS),
      ...reportBooleanLabels(notApplicableListings, REPORT_LISTING_LABELS),
    ];
    const userName = entry.user_name || entry.user_email || "Usuario nao informado";
    const sectorLabel = row.user_sectors || row.sectors || "Sem setor";
    const key = `${entry.user_id || userName}::${sectorLabel}`;
    if (!summaryByUser.has(key)) {
      summaryByUser.set(key, {
        Usuario: userName,
        Setor: sectorLabel,
        "Lotes trabalhados": new Set(),
        "Tarefas concluidas": new Set(),
        "Em andamento": new Set(),
        "Devolvidas": new Set(),
        "Canceladas": new Set(),
        "MLBs unicos": new Set(),
        Fotos: 0,
        Clips: 0,
        Titulo: 0,
        Descricao: 0,
        "Ficha tecnica": 0,
        Modelo: 0,
        Preco: 0,
        Estoque: 0,
        Promocao: 0,
        Ads: 0,
        Frete: 0,
        Outro: 0,
        "Ultima atividade": "",
      });
    }
    const summary = summaryByUser.get(key);
    summary["Lotes trabalhados"].add(row.batch_name || "Sem lote");
    summary["MLBs unicos"].add(row.mlb);
    if (entry.status_after === "completed" || entry.creates_round === true) summary["Tarefas concluidas"].add(String(row.task_id));
    else if (entry.status_after === "returned" || entry.type === "materials_returned" || returnedLabels.length) summary["Devolvidas"].add(String(row.task_id));
    else if (entry.status_after === "canceled") summary["Canceladas"].add(String(row.task_id));
    else summary["Em andamento"].add(String(row.task_id));
    reportFlagCounts(summary, [
      ...(materials.photos ? ["Fotos"] : []),
      ...(materials.clips_video ? ["Clips"] : []),
      ...(changes.photos ? ["Fotos"] : []),
      ...(changes.clips_video ? ["Clips"] : []),
      ...(changes.title ? ["Titulo"] : []),
      ...(changes.description ? ["Descricao"] : []),
      ...(changes.attributes ? ["Ficha tecnica"] : []),
      ...(changes.model ? ["Modelo"] : []),
      ...(changes.price ? ["Preco"] : []),
      ...(changes.stock ? ["Estoque"] : []),
      ...(changes.promotion ? ["Promocao"] : []),
      ...(changes.ads ? ["Ads"] : []),
      ...(changes.shipping ? ["Frete"] : []),
      ...(changes.other ? ["Outro"] : []),
    ]);
    const activityAt = entry.at ? new Date(entry.at) : null;
    const activityAtLabel = activityAt && !Number.isNaN(activityAt.getTime()) ? activityAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "";
    if (!summary["Ultima atividade"] || activityAtLabel > summary["Ultima atividade"]) summary["Ultima atividade"] = activityAtLabel;
    return {
      "Data da atividade": activityAtLabel,
      Usuario: userName,
      Setor: sectorLabel,
      "Lote/Card": row.batch_name || "Sem lote",
      "ID da tarefa": `#${row.task_id}`,
      MLB: row.mlb || "",
      SKU: row.sku || "",
      Produto: row.title_snapshot || row.mlb || "",
      "Status da tarefa": REPORT_STATUS_LABELS[row.status] || row.status || "",
      Prioridade: REPORT_PRIORITY_LABELS[row.priority] || row.priority || "",
      "Acao registrada": entry.type === "materials_returned" ? "Devolucao de material" : entry.creates_round ? "Conclusao e monitoramento" : "Registro de progresso",
      "Materiais criados": materialLabels.join(", "),
      "Materiais devolvidos": returnedLabels.join(", "),
      "Alteracoes publicadas": changeLabels.join(", "),
      "Nao se aplica": notApplicableLabels.join(", "),
      Observacao: entry.notes || entry.reason || "",
      "Data de criacao da tarefa": row.task_created_at ? new Date(row.task_created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "",
      Prazo: toYmd(row.due_date) || "",
      "Data de analise": toYmd(row.analysis_start_date) || "",
      "Concluiu monitoramento?": entry.creates_round === true ? "Sim" : "Nao",
      Tags: Array.isArray(row.batch_tags) ? row.batch_tags.join(", ") : "",
    };
  });

  const summaryRows = Array.from(summaryByUser.values()).map((row) => {
    const output = { ...row };
    ["Lotes trabalhados", "Tarefas concluidas", "Em andamento", "Devolvidas", "Canceladas", "MLBs unicos"].forEach((key) => {
      output[key] = output[key] instanceof Set ? output[key].size : output[key];
    });
    return output;
  });
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((row) => row.status === "completed").length;
  const inProgressTasks = tasks.filter((row) => row.status === "in_progress").length;
  const returnedTasks = tasks.filter((row) => row.status === "returned").length;
  const canceledTasks = tasks.filter((row) => row.status === "canceled").length;
  const uniqueUsers = new Set(activities.map((row) => row.entry?.user_id || row.entry?.user_name).filter(Boolean)).size;
  const uniqueSectors = new Set(tasks.flatMap((row) => String(row.sectors || "").split(",").map((item) => item.trim()).filter(Boolean))).size;
  const summaryGeneralRows = [
    ["Relatorio de Tarefas Estrategicas", ""],
    ["Periodo", `${range.dateFrom} ate ${range.dateTo}`],
    ["Conta", accountLabel || resolvedAccountKey],
    ["Gerado em", new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })],
    ["", ""],
    ["Total de tarefas no periodo", totalTasks],
    ["Tarefas concluidas", completedTasks],
    ["Tarefas em andamento", inProgressTasks],
    ["Tarefas devolvidas/reabertas", returnedTasks],
    ["Tarefas canceladas", canceledTasks],
    ["Usuarios envolvidos", uniqueUsers],
    ["Setores envolvidos", uniqueSectors],
    ["Atividades registradas", detailRows.length],
  ];
  const workbook = XLSX.utils.book_new();
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryGeneralRows);
  setWorksheetColumns(summarySheet, summaryGeneralRows);
  XLSX.utils.book_append_sheet(workbook, summarySheet, "Resumo geral");
  const userSheet = XLSX.utils.json_to_sheet(summaryRows.length ? summaryRows : [{ Usuario: "Sem atividades no periodo" }]);
  setWorksheetColumns(userSheet, summaryRows);
  XLSX.utils.book_append_sheet(workbook, userSheet, "Resumo por usuario");
  const detailSheet = XLSX.utils.json_to_sheet(detailRows.length ? detailRows : [{ "Data da atividade": "Sem atividades no periodo" }]);
  setWorksheetColumns(detailSheet, detailRows);
  XLSX.utils.book_append_sheet(workbook, detailSheet, "Detalhamento");
  return {
    filename: taskReportFilename(accountLabel || resolvedAccountKey),
    buffer: XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }),
  };
}

function buildCsv(rounds = []) {
  const header = ["Lote de origem", "MLB", "SKU", "Titulo", "Status", "Impacto", "Alteracao", "Revisao", "Impressoes antes", "Impressoes depois", "Cliques antes", "Cliques depois", "CTR antes", "CTR depois", "Visitas antes", "Visitas depois", "Vendas antes", "Vendas depois", "Conversao antes", "Conversao depois", "Receita antes", "Receita depois", "Observacoes"];
  const lines = [header.join(";")];
  for (const row of rounds) {
    lines.push([row.task_batch_name || "", row.mlb, row.sku, row.title, row.status, row.impact, row.alteration_date, row.review_due_date, row.before_metrics?.impressions, row.after_metrics?.impressions, row.before_metrics?.clicks, row.after_metrics?.clicks, row.before_metrics?.ctr, row.after_metrics?.ctr, row.before_metrics?.visits, row.after_metrics?.visits, row.before_metrics?.sales, row.after_metrics?.sales, row.before_metrics?.conversion, row.after_metrics?.conversion, row.before_metrics?.revenue, row.after_metrics?.revenue, row.change_notes].map(csvEscape).join(";"));
  }
  return lines.join("\r\n");
}
module.exports = { lookupItems, createRounds, createTasks, listDashboard, listWatchlist, refreshWatchlistListingStatus, refreshTaskListingStatus, getWatchlistItemDetails, listWatchlistContains, addWatchlistItem, recordWatchlistAction, recordWatchlistActionBulk, removeWatchlistItem, restoreWatchlistItem, removeWatchlistItems, addWatchlistTagsBulk, createTaskFromWatchlist, listRoundHistory, listTasks, listTaskBatches, listTaskBatchItemTokens, listTaskSectorOptions, listStrategicIntegrationStatus, listTrelloBoards, listTrelloBoardLists, previewTrelloCards, listStrategicPermissions, saveStrategicPermissions, actorCanUseStrategicAction, assertStrategicActionPermission, updateTaskBatch, cancelTaskBatch, updateTaskStatus, claimTaskBatchSector, recordTaskExecution, returnTaskMaterials, completeTask, returnRoundToTask, listGroups, createGroup, updateGroup, reviewRound, reviewDueRounds, listTaskReportOptions, buildTaskReportWorkbook, buildCsv };
