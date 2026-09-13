"use strict";

const db = require("../db/db");
const { prepareAuthState, listActiveSellerItemIds } = require("./prazoProducaoService");

const _fetch = typeof fetch !== "undefined" ? fetch : require("node-fetch");
const fetchRef = (...args) => _fetch(...args);
const ML_API = "https://api.mercadolibre.com";
const MAX_STOCK_ANALYSIS_PERIOD_DAYS = 180;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInt(value, min, max, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normMlb(value) {
  const text = String(value || "").trim().toUpperCase();
  return /^MLB\d{6,}$/.test(text) ? text : null;
}

function uniq(list) {
  return Array.from(new Set((Array.isArray(list) ? list : []).filter(Boolean)));
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function toYmd(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Math.trunc(Number(days) || 0));
  return d.toISOString().slice(0, 10);
}

function diffDays(fromYmd, toYmd) {
  const a = new Date(`${fromYmd}T00:00:00.000Z`).getTime();
  const b = new Date(`${toYmd}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

function isoStart(ymd) {
  return `${ymd}T00:00:00.000-00:00`;
}

function isoEnd(ymd) {
  return `${ymd}T23:59:59.999-00:00`;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toInt(value, fallback = 0) {
  return Math.max(0, Math.trunc(toNumber(value, fallback)));
}

function safeAccountKey(value) {
  const text = String(value || "").trim();
  return text || "default";
}

function parseTokens(input) {
  return String(input || "")
    .split(/[\s,;\n\r\t]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractSkuFromItem(item = {}) {
  const direct =
    item.seller_custom_field ||
    item.seller_sku ||
    item.sku ||
    item?.attributes?.find?.((attr) => String(attr?.id || "").toUpperCase() === "SELLER_SKU")?.value_name ||
    null;
  return direct ? String(direct).trim() : null;
}

function extractOrderItemSku(orderItem = {}) {
  return (
    orderItem.seller_sku ||
    orderItem.item?.seller_sku ||
    orderItem.item?.seller_custom_field ||
    orderItem.item?.seller_custom_field_id ||
    null
  );
}

async function renewAuthState(state) {
  const TokenService = require("./tokenService");
  if (!state?.creds || !Object.keys(state.creds).length) return false;
  const renewed = await TokenService.renovarToken(state.creds);
  const token = renewed?.access_token || state.token;
  if (!token) return false;
  state.token = token;
  state.creds.access_token = token;
  if (renewed?.refresh_token) state.creds.refresh_token = renewed.refresh_token;
  return true;
}

async function authFetch(state, pathOrUrl, init = {}) {
  const url = /^https?:\/\//i.test(String(pathOrUrl || ""))
    ? String(pathOrUrl)
    : `${ML_API}${String(pathOrUrl || "")}`;
  const call = (token) => fetchRef(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });

  let response = await call(state.token);
  if (response.status !== 401) return response;
  const renewed = await renewAuthState(state);
  if (!renewed) return response;
  return call(state.token);
}

async function mlJson(state, pathOrUrl, init = {}, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await authFetch(state, pathOrUrl, init);
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    if (response.status === 429 && attempt < attempts) {
      await sleep(450 * attempt);
      continue;
    }
    lastError = new Error(data?.message || data?.error || `Mercado Livre HTTP ${response.status}`);
    lastError.statusCode = response.status;
    lastError.details = data;
    break;
  }
  throw lastError || new Error("Falha ao consultar Mercado Livre.");
}

async function getSellerId(state, mlCreds = {}) {
  const fromCreds = mlCreds?.meli_user_id || mlCreds?.user_id || state?.creds?.meli_user_id || state?.creds?.user_id;
  if (fromCreds) return String(fromCreds);
  const me = await mlJson(state, "/users/me");
  if (!me?.id) throw new Error("Nao foi possivel identificar o seller_id da conta.");
  return String(me.id);
}

async function fetchItemDetails(state, ids = []) {
  const result = [];
  const uniqueIds = uniq(ids.map(normMlb));
  for (let i = 0; i < uniqueIds.length; i += 20) {
    const chunk = uniqueIds.slice(i, i + 20);
    if (!chunk.length) continue;
    const attrs = [
      "id",
      "title",
      "status",
      "available_quantity",
      "seller_custom_field",
      "price",
      "thumbnail",
      "secure_thumbnail",
      "permalink",
      "seller_id",
      "shipping",
      "variations",
      "attributes",
    ].join(",");
    const data = await mlJson(
      state,
      `/items?ids=${encodeURIComponent(chunk.join(","))}&attributes=${encodeURIComponent(attrs)}`,
    );
    const rows = Array.isArray(data) ? data : [];
    rows.forEach((entry) => {
      const body = entry?.body || entry;
      if (body?.id) result.push(body);
    });
  }
  return result;
}

async function resolveItemsBySource({ state, mlCreds, source, query, maxItems, onProgress }) {
  const normalizedSource = String(source || "manual").toLowerCase();
  if (normalizedSource === "active") {
    const listing = await listActiveSellerItemIds({
      authState: state,
      mlCreds,
      maxItems,
      onProgress: async (payload) => {
        if (typeof onProgress === "function") await onProgress({ phase: "listing", ...payload });
      },
    });
    return {
      sellerId: listing.sellerId,
      ids: listing.ids,
      source: "active",
      listing,
    };
  }

  const tokens = parseTokens(query);
  const mlbIds = uniq(tokens.map(normMlb));
  const skuTokens = uniq(tokens.filter((token) => !normMlb(token)).map((token) => token.toUpperCase()));
  let skuMatchedIds = [];
  let sellerId = await getSellerId(state, mlCreds);

  if (skuTokens.length) {
    const listing = await listActiveSellerItemIds({ authState: state, mlCreds, maxItems: null });
    sellerId = listing.sellerId || sellerId;
    const activeItems = await fetchItemDetails(state, listing.ids);
    skuMatchedIds = activeItems
      .filter((item) => skuTokens.includes(String(extractSkuFromItem(item) || "").toUpperCase()))
      .map((item) => normMlb(item.id))
      .filter(Boolean);
  }

  const ids = uniq([...mlbIds, ...skuMatchedIds]);
  if (!ids.length) throw new Error("Informe MLBs validos ou SKUs de anuncios ativos para monitorar.");
  return { sellerId, ids, source: "manual", requestedSkus: skuTokens };
}

function sumSalesInRange(sales = {}, fromYmd, toYmd) {
  const salesByDate = sales?.sales_by_date || {};
  return Object.entries(salesByDate).reduce((sum, [day, qty]) => {
    if (day >= fromYmd && day <= toYmd) return sum + toInt(qty, 0);
    return sum;
  }, 0);
}

async function fetchPaidOrdersByItem({ state, sellerId, fromYmd, toYmd: untilYmd, onProgress }) {
  const byItem = new Map();
  const orders = [];
  const limit = 50;
  let totalAvailable = 0;
  let offset = 0;
  const referenceTime = new Date(`${untilYmd}T23:59:59.999Z`).getTime();

  for (;;) {
    const url = new URL(`${ML_API}/orders/search`);
    url.searchParams.set("seller", sellerId);
    url.searchParams.set("order.status", "paid");
    url.searchParams.set("order.date_created.from", isoStart(fromYmd));
    url.searchParams.set("order.date_created.to", isoEnd(untilYmd));
    url.searchParams.set("sort", "date_desc");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    const payload = await mlJson(state, url.toString(), {}, 4);
    const batch = Array.isArray(payload?.results) ? payload.results : [];
    totalAvailable = toInt(payload?.paging?.total, totalAvailable);

    for (const order of batch) {
      orders.push(order);
      const date = order?.date_created || order?.date_closed || null;
      for (const orderItem of Array.isArray(order?.order_items) ? order.order_items : []) {
        const mlb = normMlb(orderItem?.item?.id);
        if (!mlb) continue;
        const qty = toInt(orderItem?.quantity, 0);
        const current = byItem.get(mlb) || {
          mlb,
          sku: extractOrderItemSku(orderItem),
          sales_30d: 0,
          sales_60d: 0,
          sales_90d: 0,
          sales_by_date: {},
          last_sale_at: null,
        };
        const ageDays = Math.max(0, Math.floor((referenceTime - new Date(date).getTime()) / 86400000));
        const saleDay = toYmd(date);
        if (ageDays < 30) current.sales_30d += qty;
        if (ageDays < 60) current.sales_60d += qty;
        if (ageDays < 90) current.sales_90d += qty;
        if (saleDay) current.sales_by_date[saleDay] = (current.sales_by_date[saleDay] || 0) + qty;
        if (date && (!current.last_sale_at || String(date) > String(current.last_sale_at))) {
          current.last_sale_at = date;
        }
        byItem.set(mlb, current);
      }
    }

    if (typeof onProgress === "function") {
      await onProgress({ phase: "orders", scanned: orders.length, totalAvailable });
    }

    offset += batch.length;
    if (!batch.length) break;
    if (totalAvailable && offset >= totalAvailable) break;
    if (offset >= 10000) break;
  }

  return { byItem, orders_scanned: orders.length, total_available: totalAvailable };
}

function classifyTrend(sales30, sales90) {
  const avg30 = Number(sales30 || 0) / 30;
  const avg90 = Number(sales90 || 0) / 90;
  if (avg90 <= 0 && avg30 > 0) return { key: "growth", label: "Crescimento", factor: 1.2, delta_pct: null };
  if (avg90 <= 0) return { key: "stable", label: "Sem base", factor: 1, delta_pct: 0 };
  const delta = ((avg30 - avg90) / avg90) * 100;
  if (delta >= 15) return { key: "growth", label: "Crescimento", factor: 1.2, delta_pct: delta };
  if (delta <= -15) return { key: "down", label: "Queda", factor: 0.85, delta_pct: delta };
  return { key: "stable", label: "Estavel", factor: 1, delta_pct: delta };
}

function classifyRisk(stock, avgDaily, pendingPurchase) {
  if (pendingPurchase) return { key: "waiting_stock", label: "Aguardando estoque", rank: 0 };
  if (stock <= 0) return { key: "out", label: "Ruptura", rank: 5 };
  if (avgDaily <= 0) return { key: "no_sales", label: "Sem giro", rank: 1 };
  const days = stock / avgDaily;
  if (days <= 7) return { key: "critical", label: "Critico", rank: 4 };
  if (days <= 15) return { key: "high", label: "Alto", rank: 3 };
  if (days <= 30) return { key: "medium", label: "Atencao", rank: 2 };
  return { key: "low", label: "Baixo", rank: 1 };
}

function buildMetrics({ item, sales, periodDays, customRange, purchase }) {
  const stock = toInt(item?.available_quantity, 0);
  const price = toNumber(item?.price, 0);
  const sales30 = toInt(sales?.sales_30d, 0);
  const sales60 = toInt(sales?.sales_60d, 0);
  const sales90 = toInt(sales?.sales_90d, 0);
  const selectedDays = customRange?.from && customRange?.to ? diffDays(customRange.from, customRange.to) : periodDays;
  let selectedSales = sales30;
  if (customRange?.from && customRange?.to) {
    const salesByDate = sales?.sales_by_date || {};
    selectedSales = Object.entries(salesByDate).reduce((sum, [day, qty]) => {
      if (day >= customRange.from && day <= customRange.to) return sum + toInt(qty, 0);
      return sum;
    }, 0);
  } else if (selectedDays > 60) selectedSales = sales90;
  else if (selectedDays > 30) selectedSales = sales60;
  else selectedSales = sales30;

  const avgDaily = selectedSales / Math.max(1, selectedDays);
  const trend = classifyTrend(sales30, sales90);
  const adjustedAvg = avgDaily * trend.factor;
  const coverageDays = adjustedAvg > 0 ? stock / adjustedAvg : null;
  const stockoutDate = coverageDays != null ? addDays(todayYmd(), Math.ceil(coverageDays)) : null;
  const pendingPurchase = String(purchase?.purchase_status || "") === "waiting_stock";
  const risk = classifyRisk(stock, adjustedAvg, pendingPurchase);
  const safetyStock = Math.ceil(adjustedAvg * 7);
  const targetCoverageDays = trend.key === "growth" ? 45 : trend.key === "down" ? 25 : 35;
  const idealStock = Math.ceil(adjustedAvg * targetCoverageDays + safetyStock);
  const suggestedRestock = Math.max(0, idealStock - stock);
  const suggestedPurchaseValue = Number((suggestedRestock * price).toFixed(2));
  const turnover = stock > 0 ? sales90 / stock : sales90 > 0 ? sales90 : 0;

  let alert = null;
  if (["out", "critical", "high"].includes(risk.key) && stockoutDate) {
    alert = `Realizar nova compra deste item, pois o estoque acabara ate ${formatDateBr(stockoutDate)}.`;
  }

  return {
    stock,
    price,
    sales_30d: sales30,
    sales_60d: sales60,
    sales_90d: sales90,
    period_days: selectedDays,
    selected_sales: selectedSales,
    avg_daily: Number(avgDaily.toFixed(4)),
    adjusted_avg_daily: Number(adjustedAvg.toFixed(4)),
    coverage_days: coverageDays == null ? null : Number(coverageDays.toFixed(2)),
    stockout_date: stockoutDate,
    trend,
    risk,
    turnover: Number(turnover.toFixed(4)),
    safety_stock: safetyStock,
    ideal_stock: idealStock,
    suggested_restock: suggestedRestock,
    suggested_purchase_value: suggestedPurchaseValue,
    alert,
  };
}

function formatDateBr(ymd) {
  if (!ymd) return "-";
  const [y, m, d] = String(ymd).slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function buildInsights(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const critical = safeRows.filter((row) => ["out", "critical"].includes(row.risk_level));
  const high = safeRows.filter((row) => row.risk_level === "high");
  const growth = safeRows.filter((row) => row.trend_key === "growth");
  const down = safeRows.filter((row) => row.trend_key === "down");
  const topTurnover = safeRows.slice().sort((a, b) => Number(b.turnover || 0) - Number(a.turnover || 0))[0];
  const lowTurnover = safeRows.filter((row) => Number(row.sales_90d || 0) === 0 && Number(row.current_stock || 0) > 0).length;
  const pending = safeRows.filter((row) => row.purchase_status === "waiting_stock");

  const insights = [];
  if (critical.length) {
    insights.push({ tone: "critical", title: `${critical.length} produto(s) em risco critico`, text: "Priorize compra ou redistribuicao de estoque para evitar ruptura nos proximos dias." });
  } else if (high.length) {
    insights.push({ tone: "warning", title: `${high.length} produto(s) em risco alto`, text: "A cobertura ainda existe, mas a janela de compra ja esta curta." });
  } else {
    insights.push({ tone: "positive", title: "Sem ruptura critica no recorte", text: "Os itens analisados nao indicam ruptura imediata com a media atual de vendas." });
  }

  if (growth.length) {
    insights.push({ tone: "info", title: `${growth.length} produto(s) em crescimento`, text: "A recomendacao usa um fator de demanda maior para reduzir risco de subcompra." });
  }
  if (down.length) {
    insights.push({ tone: "neutral", title: `${down.length} produto(s) em queda`, text: "A compra sugerida foi suavizada para evitar excesso de estoque parado." });
  }
  if (topTurnover) {
    insights.push({ tone: "info", title: `Maior giro: ${topTurnover.sku || topTurnover.mlb}`, text: `${topTurnover.sales_90d} unidade(s) em 90 dias com estoque atual de ${topTurnover.current_stock}.` });
  }
  if (lowTurnover) {
    insights.push({ tone: "warning", title: `${lowTurnover} produto(s) sem giro`, text: "Revise precificacao, ads ou necessidade de reposicao antes de comprar novamente." });
  }
  if (pending.length) {
    insights.push({ tone: "info", title: `${pending.length} compra(s) aguardando chegada`, text: "Esses itens saem do alerta de ruptura ate a data prevista ou aumento automatico do estoque." });
  }

  return insights.slice(0, 6);
}

function summarizeRows(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const critical = safeRows.filter((row) => ["out", "critical"].includes(row.risk_level)).length;
  const high = safeRows.filter((row) => row.risk_level === "high").length;
  const medium = safeRows.filter((row) => row.risk_level === "medium").length;
  const waiting = safeRows.filter((row) => row.purchase_status === "waiting_stock").length;
  const avgCoverageRows = safeRows.filter((row) => Number.isFinite(Number(row.coverage_days)));
  const avgCoverage = avgCoverageRows.length
    ? avgCoverageRows.reduce((sum, row) => sum + Number(row.coverage_days || 0), 0) / avgCoverageRows.length
    : null;
  const suggested = safeRows.reduce((sum, row) => sum + toInt(row.suggested_restock, 0), 0);
  return {
    total: safeRows.length,
    critical,
    high,
    medium,
    waiting,
    risk_total: critical + high,
    avg_coverage_days: avgCoverage == null ? null : Number(avgCoverage.toFixed(1)),
    suggested_restock_total: suggested,
  };
}

async function getExistingPurchases(accountKey, ids) {
  if (!ids.length) return new Map();
  const result = await db.query(
    `select mlb, purchase_status, expected_arrival_date, last_stock_seen, current_stock
       from ml_stock_watch_items
      where account_key = $1 and mlb = any($2::text[])`,
    [accountKey, ids],
  );
  return new Map(result.rows.map((row) => [row.mlb, row]));
}

async function saveRows({ accountKey, accountLabel, sellerId, rows }) {
  for (const row of rows) {
    await db.query(
      `insert into ml_stock_watch_items
        (account_key, account_label, seller_id, mlb, sku, title, thumbnail, permalink, status,
         current_stock, sales_30d, sales_60d, sales_90d, avg_daily, coverage_days,
         stockout_date, trend, risk_level, turnover, suggested_restock, safety_stock,
         purchase_status, expected_arrival_date, last_stock_seen, metrics, last_analyzed_at, updated_at)
       values
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,now(),now())
       on conflict (account_key, mlb) do update set
         account_label = excluded.account_label,
         seller_id = excluded.seller_id,
         sku = excluded.sku,
         title = excluded.title,
         thumbnail = excluded.thumbnail,
         permalink = excluded.permalink,
         status = excluded.status,
         current_stock = excluded.current_stock,
         sales_30d = excluded.sales_30d,
         sales_60d = excluded.sales_60d,
         sales_90d = excluded.sales_90d,
         avg_daily = excluded.avg_daily,
         coverage_days = excluded.coverage_days,
         stockout_date = excluded.stockout_date,
         trend = excluded.trend,
         risk_level = excluded.risk_level,
         turnover = excluded.turnover,
         suggested_restock = excluded.suggested_restock,
         safety_stock = excluded.safety_stock,
         purchase_status = excluded.purchase_status,
         expected_arrival_date = excluded.expected_arrival_date,
         last_stock_seen = excluded.last_stock_seen,
         metrics = excluded.metrics,
         last_analyzed_at = now(),
         updated_at = now()`,
      [
        accountKey,
        accountLabel || null,
        sellerId || null,
        row.mlb,
        row.sku || null,
        row.title || null,
        row.thumbnail || null,
        row.permalink || null,
        row.status || null,
        row.current_stock,
        row.sales_30d,
        row.sales_60d,
        row.sales_90d,
        row.avg_daily,
        row.coverage_days,
        row.stockout_date,
        row.trend_key,
        row.risk_level,
        row.turnover,
        row.suggested_restock,
        row.safety_stock,
        row.purchase_status || "monitoring",
        row.expected_arrival_date || null,
        row.last_stock_seen,
        JSON.stringify(row.metrics || {}),
      ],
    );
  }
}

function rowFromItem({ item, sales, metrics, purchase }) {
  const previousStock = toInt(purchase?.last_stock_seen ?? purchase?.current_stock, 0);
  const stockIncreased = String(purchase?.purchase_status || "") === "waiting_stock" && metrics.stock > previousStock;
  const purchaseStatus = stockIncreased ? "monitoring" : (purchase?.purchase_status || "monitoring");
  const expectedArrival = stockIncreased ? null : purchase?.expected_arrival_date || null;
  const risk = purchaseStatus === "waiting_stock" ? classifyRisk(metrics.stock, metrics.adjusted_avg_daily, true) : metrics.risk;

  return {
    mlb: normMlb(item.id),
    sku: extractSkuFromItem(item) || sales?.sku || null,
    title: item.title || null,
    thumbnail: item.secure_thumbnail || item.thumbnail || null,
    permalink: item.permalink || null,
    status: item.status || null,
    price: metrics.price,
    current_stock: metrics.stock,
    sales_30d: metrics.sales_30d,
    sales_60d: metrics.sales_60d,
    sales_90d: metrics.sales_90d,
    avg_daily: metrics.adjusted_avg_daily,
    raw_avg_daily: metrics.avg_daily,
    coverage_days: metrics.coverage_days,
    stockout_date: metrics.stockout_date,
    trend_key: metrics.trend.key,
    trend_label: metrics.trend.label,
    trend_delta_pct: metrics.trend.delta_pct,
    risk_level: risk.key,
    risk_label: risk.label,
    risk_rank: risk.rank,
    turnover: metrics.turnover,
    suggested_restock: metrics.suggested_restock,
    suggested_purchase_value: metrics.suggested_purchase_value,
    safety_stock: metrics.safety_stock,
    ideal_stock: metrics.ideal_stock,
    purchase_status: purchaseStatus,
    expected_arrival_date: toYmd(expectedArrival),
    last_stock_seen: metrics.stock,
    alert: purchaseStatus === "waiting_stock" ? null : metrics.alert,
    arrival_alert: buildArrivalAlert({ purchaseStatus, expectedArrival: toYmd(expectedArrival) }),
    metrics,
  };
}

function buildArrivalAlert({ purchaseStatus, expectedArrival }) {
  if (purchaseStatus !== "waiting_stock" || !expectedArrival) return null;
  const arrivalYmd = toYmd(expectedArrival);
  if (!arrivalYmd) return null;
  const days = diffDays(todayYmd(), arrivalYmd) - 1;
  if (days === 2) return "O novo estoque esta previsto para chegar em 2 dias.";
  if (days === 1) return "O novo estoque chega amanha. Reforce a conferencia da entrega.";
  if (days === 0) return "Atencao: o novo estoque deste produto esta previsto para chegar hoje. Confirme se a mercadoria ja chegou.";
  if (days < 0) return "A data prevista de chegada ja passou. Confirme se o estoque foi atualizado.";
  return null;
}

async function analyzeStock({
  accessToken,
  mlCreds = {},
  accountKey,
  accountLabel,
  source = "manual",
  query = "",
  maxItems = null,
  periodDays = 30,
  customFrom = null,
  customTo = null,
  onProgress = null,
} = {}) {
  if (typeof onProgress === "function") await onProgress({ phase: "auth", processed: 0, total: 0 });
  const state = await prepareAuthState({ accessToken, mlCreds });
  const safeAccountKeyLocal = safeAccountKeyValue(accountKey, mlCreds);
  const safePeriodDays = clampInt(periodDays, 7, MAX_STOCK_ANALYSIS_PERIOD_DAYS, 30);
  const customRange = customFrom && customTo ? { from: toYmd(customFrom), to: toYmd(customTo) } : null;
  if (customFrom || customTo) {
    if (!customRange?.from || !customRange?.to) {
      const error = new Error("Informe a data inicial e final do periodo personalizado.");
      error.statusCode = 400;
      throw error;
    }
    if (customRange.to < customRange.from) {
      const error = new Error("A data final nao pode ser menor que a data inicial.");
      error.statusCode = 400;
      throw error;
    }
    if (diffDays(customRange.from, customRange.to) > MAX_STOCK_ANALYSIS_PERIOD_DAYS) {
      const error = new Error(`Periodo personalizado limitado a ${MAX_STOCK_ANALYSIS_PERIOD_DAYS} dias.`);
      error.statusCode = 400;
      throw error;
    }
  }
  const selectedRange = customRange || {
    from: addDays(todayYmd(), -(safePeriodDays - 1)),
    to: todayYmd(),
  };
  const analysisToYmd = selectedRange.to || todayYmd();
  const ninetyDaysFrom = addDays(analysisToYmd, -89);
  const maxWindowFrom = selectedRange.from < ninetyDaysFrom ? selectedRange.from : ninetyDaysFrom;

  let resolved = null;
  let orders = null;

  if (String(source || "").toLowerCase() === "sold_period") {
    if (typeof onProgress === "function") await onProgress({ phase: "seller", processed: 0, total: 0 });
    const sellerId = await getSellerId(state, mlCreds);
    if (typeof onProgress === "function") await onProgress({ phase: "orders", processed: 0, total: 0 });
    orders = await fetchPaidOrdersByItem({
      state,
      sellerId,
      fromYmd: maxWindowFrom,
      toYmd: analysisToYmd,
      onProgress,
    });
    const max = maxItems == null || maxItems === "" ? null : clampInt(maxItems, 1, 50000);
    const ids = Array.from(orders.byItem.entries())
      .filter(([, sales]) => sumSalesInRange(sales, selectedRange.from, selectedRange.to) > 0)
      .sort((a, b) => {
        const salesA = sumSalesInRange(a[1], selectedRange.from, selectedRange.to);
        const salesB = sumSalesInRange(b[1], selectedRange.from, selectedRange.to);
        return salesB - salesA;
      })
      .map(([id]) => id)
      .slice(0, max || undefined);
    resolved = { sellerId, ids, source: "sold_period" };
  } else {
    resolved = await resolveItemsBySource({
      state,
      mlCreds,
      source,
      query,
      maxItems,
      onProgress,
    });
  }

  const ids = resolved.ids;
  if (!ids.length) throw new Error("Nenhum anuncio encontrado para analise de estoque.");
  if (typeof onProgress === "function") await onProgress({ phase: "details", processed: 0, total: ids.length });

  const details = await fetchItemDetails(state, ids);
  const itemMap = new Map(details.map((item) => [normMlb(item.id), item]).filter(([id]) => id));
  if (!orders) {
    orders = await fetchPaidOrdersByItem({
      state,
      sellerId: resolved.sellerId,
      fromYmd: maxWindowFrom,
      toYmd: analysisToYmd,
      onProgress,
    });
  }
  const existing = await getExistingPurchases(safeAccountKeyLocal, ids);
  const rows = [];
  let processed = 0;

  for (const id of ids) {
    const item = itemMap.get(id);
    if (!item) continue;
    const sales = orders.byItem.get(id) || { mlb: id, sales_30d: 0, sales_60d: 0, sales_90d: 0 };
    const purchase = existing.get(id) || null;
    const metrics = buildMetrics({ item, sales, periodDays: safePeriodDays, customRange, purchase });
    rows.push(rowFromItem({ item, sales, metrics, purchase }));
    processed += 1;
    if (typeof onProgress === "function") await onProgress({ phase: "metrics", processed, total: ids.length });
  }

  rows.sort((a, b) => Number(b.risk_rank || 0) - Number(a.risk_rank || 0) || Number(a.coverage_days || 99999) - Number(b.coverage_days || 99999));
  await saveRows({ accountKey: safeAccountKeyLocal, accountLabel, sellerId: resolved.sellerId, rows });

  return {
    success: true,
    source: resolved.source,
    seller_id: resolved.sellerId,
    account: { key: safeAccountKeyLocal, label: accountLabel || null },
    filters: { period_days: safePeriodDays, custom_from: customRange?.from || null, custom_to: customRange?.to || null, max_items: maxItems || null },
    orders_scanned: orders.orders_scanned,
    total: rows.length,
    summary: summarizeRows(rows),
    insights: buildInsights(rows),
    rows,
  };
}

function safeAccountKeyValue(accountKey, mlCreds = {}) {
  return safeAccountKey(accountKey || mlCreds?.meli_conta_id || mlCreds?.id || mlCreds?.meli_user_id);
}

async function markPurchase({ accountKey, mlb, expectedArrivalDate }) {
  const id = normMlb(mlb);
  if (!id) throw new Error("MLB invalido para marcar compra.");
  const date = String(expectedArrivalDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Informe a data prevista de chegada.");
  const safeKey = safeAccountKey(accountKey);

  const result = await db.query(
    `update ml_stock_watch_items
        set purchase_status = 'waiting_stock',
            expected_arrival_date = $3,
            last_stock_seen = current_stock,
            updated_at = now()
      where account_key = $1 and mlb = $2
      returning *`,
    [safeKey, id, date],
  );
  if (!result.rowCount) throw new Error("Produto ainda nao monitorado nesta conta.");
  await db.query(
    `insert into ml_stock_watch_events (account_key, mlb, event_type, message, payload)
     values ($1,$2,'purchase_marked',$3,$4::jsonb)`,
    [safeKey, id, `Compra realizada. Chegada prevista para ${formatDateBr(date)}.`, JSON.stringify({ expected_arrival_date: date })],
  );
  return { success: true, item: mapDbRow(result.rows[0]) };
}

async function clearPurchase({ accountKey, mlb }) {
  const id = normMlb(mlb);
  if (!id) throw new Error("MLB invalido.");
  const safeKey = safeAccountKey(accountKey);
  const result = await db.query(
    `update ml_stock_watch_items
        set purchase_status = 'monitoring', expected_arrival_date = null, updated_at = now()
      where account_key = $1 and mlb = $2
      returning *`,
    [safeKey, id],
  );
  if (!result.rowCount) throw new Error("Produto nao encontrado.");
  return { success: true, item: mapDbRow(result.rows[0]) };
}

async function removeWatchItem({ accountKey, mlb }) {
  const id = normMlb(mlb);
  if (!id) throw new Error("MLB invalido para remover da watchlist.");
  const safeKey = safeAccountKey(accountKey);
  const result = await db.query(
    `delete from ml_stock_watch_items
      where account_key = $1 and mlb = $2
      returning mlb, sku, title`,
    [safeKey, id],
  );
  if (!result.rowCount) throw new Error("Produto nao encontrado na watchlist.");
  await db.query(
    `insert into ml_stock_watch_events (account_key, mlb, event_type, message, payload)
     values ($1,$2,'watch_removed',$3,$4::jsonb)`,
    [safeKey, id, "Produto removido da watchlist de estoque.", JSON.stringify(result.rows[0] || {})],
  );
  return { success: true, removed: result.rows[0] };
}

function mapDbRow(row = {}) {
  const stockoutDate = toYmd(row.stockout_date);
  const expectedArrival = toYmd(row.expected_arrival_date);
  return {
    mlb: row.mlb,
    sku: row.sku,
    title: row.title,
    thumbnail: row.thumbnail,
    permalink: row.permalink,
    status: row.status,
    price: toNumber(row.metrics?.price, 0),
    current_stock: toInt(row.current_stock, 0),
    sales_30d: toInt(row.sales_30d, 0),
    sales_60d: toInt(row.sales_60d, 0),
    sales_90d: toInt(row.sales_90d, 0),
    avg_daily: toNumber(row.avg_daily, 0),
    coverage_days: row.coverage_days == null ? null : toNumber(row.coverage_days, null),
    stockout_date: stockoutDate,
    trend_key: row.trend,
    risk_level: row.risk_level,
    turnover: toNumber(row.turnover, 0),
    suggested_restock: toInt(row.suggested_restock, 0),
    suggested_purchase_value: toNumber(row.metrics?.suggested_purchase_value, 0),
    safety_stock: toInt(row.safety_stock, 0),
    purchase_status: row.purchase_status,
    expected_arrival_date: expectedArrival,
    last_analyzed_at: row.last_analyzed_at,
    updated_at: row.updated_at,
    metrics: row.metrics || {},
    alert: row.metrics?.alert || null,
    arrival_alert: buildArrivalAlert({ purchaseStatus: row.purchase_status, expectedArrival }),
  };
}

async function listStored({ accountKey, limit = 250 } = {}) {
  const result = await db.query(
    `select * from ml_stock_watch_items
      where account_key = $1
      order by
        case risk_level when 'out' then 6 when 'critical' then 5 when 'high' then 4 when 'medium' then 3 when 'low' then 2 else 1 end desc,
        stockout_date asc nulls last,
        updated_at desc
      limit $2`,
    [safeAccountKey(accountKey), clampInt(limit, 1, 1000, 250)],
  );
  const rows = result.rows.map(mapDbRow);
  return { success: true, summary: summarizeRows(rows), insights: buildInsights(rows), rows };
}

async function riskKpi({ accountKey, limit = 5 } = {}) {
  const safeKey = safeAccountKey(accountKey);
  const countResult = await db.query(
    `select count(*)::int as total
       from ml_stock_watch_items
      where account_key = $1
        and coalesce(purchase_status, 'monitoring') <> 'waiting_stock'
        and risk_level in ('out', 'critical', 'high')`,
    [safeKey],
  );
  const result = await db.query(
    `select * from ml_stock_watch_items
      where account_key = $1
        and coalesce(purchase_status, 'monitoring') <> 'waiting_stock'
        and risk_level in ('out', 'critical', 'high')
      order by
        case risk_level when 'out' then 6 when 'critical' then 5 when 'high' then 4 else 1 end desc,
        stockout_date asc nulls last
      limit $2`,
    [safeKey, clampInt(limit, 1, 20, 5)],
  );
  const rows = result.rows.map(mapDbRow);
  return { success: true, total: toInt(countResult.rows?.[0]?.total, rows.length), rows };
}

function buildCsvRows(rows = []) {
  return rows.map((row) => [
    row.mlb,
    row.sku || "",
    row.title || "",
    row.current_stock,
    row.sales_30d,
    row.sales_60d,
    row.sales_90d,
    String(row.avg_daily ?? ""),
    String(row.coverage_days ?? ""),
    row.stockout_date ? formatDateBr(row.stockout_date) : "",
    row.trend_label || row.trend_key || "",
    row.risk_label || row.risk_level || "",
    row.turnover,
    row.safety_stock,
    row.suggested_restock,
    row.purchase_status === "waiting_stock" ? "Aguardando chegada de novo estoque" : "Monitorando",
    row.expected_arrival_date ? formatDateBr(row.expected_arrival_date) : "",
    row.alert || row.arrival_alert || "",
  ]);
}

const CSV_HEADER = [
  "MLB",
  "SKU",
  "Nome do produto",
  "Estoque atual",
  "Vendas 30 dias",
  "Vendas 60 dias",
  "Vendas 90 dias",
  "Media diaria ajustada",
  "Cobertura em dias",
  "Previsao de ruptura",
  "Tendencia",
  "Risco",
  "Giro 90d/estoque",
  "Estoque de seguranca",
  "Reposicao sugerida",
  "Status compra",
  "Chegada prevista",
  "Alerta",
];

module.exports = {
  analyzeStock,
  markPurchase,
  clearPurchase,
  removeWatchItem,
  listStored,
  riskKpi,
  buildCsvRows,
  CSV_HEADER,
  formatDateBr,
};
