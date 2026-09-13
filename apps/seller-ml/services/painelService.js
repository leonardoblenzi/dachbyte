"use strict";

const ProductAdsService = require("./productAdsService");
const FinanceiroMlService = require("./financeiroMlService");

const _fetch = typeof fetch !== "undefined" ? fetch : require("node-fetch");
const fetchRef = (...args) => _fetch(...args);

const PAINEL_CACHE = new Map();
const CACHE_TTL_BY_PRESET_MS = {
  today: 1000 * 60 * 3,
  "7d": 1000 * 60 * 60,
  "14d": 1000 * 60 * 90,
  "30d": 1000 * 60 * 120,
  default: 1000 * 60 * 5,
};
const BILLING_ORDER_DETAILS_URL =
  "https://api.mercadolibre.com/billing/integration/group/ML/order/details";
const LIMITS_BY_TIER = {
  green: { claims: 2.0, mediations: 0.5, cancellations: 1.5, delayed: 10.0 },
  leader: { claims: 1.0, mediations: 0.5, cancellations: 0.5, delayed: 6.0 },
  gold: { claims: 1.0, mediations: 0.5, cancellations: 0.5, delayed: 6.0 },
  platinum: { claims: 1.0, mediations: 0.5, cancellations: 0.5, delayed: 6.0 },
  default: { claims: 2.0, mediations: 0.5, cancellations: 1.5, delayed: 10.0 },
};
const SOURCE_TIMEOUT_MS = {
  orders: 32000,
  activeItemsTotal: 2500,
  activeItems: 5000,
  activeItemsBackground: 60000,
  productAds: 5000,
  visits: 5000,
  reputation: 4000,
  billing: 3500,
  financeQuick: 65000,
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toISODate(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

function parseISODate(value) {
  const [y, m, d] = String(value || "")
    .split("-")
    .map((part) => Number(part));
  return new Date(y, (m || 1) - 1, d || 1);
}

function addDays(value, amount) {
  const date = parseISODate(value);
  date.setDate(date.getDate() + amount);
  return toISODate(date);
}

function diffDaysInclusive(from, to) {
  const start = parseISODate(from);
  const end = parseISODate(to);
  const diff = Math.round((end - start) / 86400000);
  return Math.max(1, diff + 1);
}

function todayISO() {
  return toISODate(new Date());
}

function daysInMonthFromISO(value) {
  const date = parseISODate(value);
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function monthKey(value) {
  return String(value || "").slice(0, 7);
}

function startOfMonth(value) {
  const date = parseISODate(value);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-01`;
}

function endOfMonth(value) {
  const date = parseISODate(value);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate(),
  )}`;
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pick(obj, ...paths) {
  for (const path of paths) {
    let cur = obj;
    let ok = true;
    for (const key of path.split(".")) {
      if (cur == null || !(key in cur)) {
        ok = false;
        break;
      }
      cur = cur[key];
    }
    if (ok && cur != null) return cur;
  }
  return null;
}

function lower(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function chunkArray(items = [], size = 50) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function currentRangeFromPreset(preset) {
  const today = todayISO();
  const yesterday = addDays(today, -1);
  switch (String(preset || "today")) {
    case "7d":
      return {
        preset: "7d",
        label: "7 dias",
        date_from: addDays(yesterday, -6),
        date_to: yesterday,
      };
    case "14d":
      return {
        preset: "14d",
        label: "14 dias",
        date_from: addDays(yesterday, -13),
        date_to: yesterday,
      };
    case "30d":
      return {
        preset: "30d",
        label: "30 dias",
        date_from: addDays(yesterday, -29),
        date_to: yesterday,
      };
    case "today":
    default:
      return {
        preset: "today",
        label: "Hoje",
        date_from: today,
        date_to: today,
      };
  }
}

function buildCompareRange(current) {
  const days = diffDaysInclusive(current.date_from, current.date_to);
  const prevTo = addDays(current.date_from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  return {
    preset: `${current.preset}_compare`,
    label: `${days} dia(s) anteriores`,
    date_from: prevFrom,
    date_to: prevTo,
    days,
  };
}

function isoStartOfDayBR(dateISO) {
  return `${dateISO}T00:00:00.000-03:00`;
}

function isoEndOfDayBR(dateISO) {
  return `${dateISO}T23:59:59.999-03:00`;
}

function makeCacheKey({ accountKey, sellerId, preset }) {
  return JSON.stringify({
    accountKey: String(accountKey || ""),
    sellerId: String(sellerId || ""),
    preset: String(preset || "today"),
  });
}

function resolveCacheTtlMs(preset) {
  return (
    CACHE_TTL_BY_PRESET_MS[String(preset || "").trim()] ||
    CACHE_TTL_BY_PRESET_MS.default
  );
}

function getCache(key) {
  const entry = PAINEL_CACHE.get(key);
  if (!entry) return null;
  if (
    Date.now() - entry.createdAt >
    numberOrZero(entry.ttlMs || CACHE_TTL_BY_PRESET_MS.default)
  ) {
    PAINEL_CACHE.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data, ttlMs) {
  PAINEL_CACHE.set(key, { createdAt: Date.now(), ttlMs, data });
}

async function httpGetJson(url, accessToken, retries = 2, extraHeaders = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i += 1) {
    try {
      const response = await fetchRef(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...extraHeaders,
        },
      });

      const text = await response.text().catch(() => "");
      const data = text ? JSON.parse(text) : null;

      if (!response.ok) {
        const err = new Error(
          data?.message ||
            data?.error ||
            data?.cause?.[0]?.message ||
            `HTTP ${response.status}`,
        );
        err.statusCode = response.status;
        err.payload = data;
        throw err;
      }

      return data;
    } catch (error) {
      lastErr = error;
      if (i < retries) {
        await new Promise((resolve) => setTimeout(resolve, 220 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

async function getMe(accessToken) {
  return httpGetJson("https://api.mercadolibre.com/users/me", accessToken, 1);
}

async function fetchOrdersByStatus(
  accessToken,
  sellerId,
  status,
  fromISO,
  toISO,
  hardCap = 5000,
  dateField = "order.date_closed",
) {
  const orders = [];
  const limit = 50;
  let offset = 0;
  let total = Infinity;

  while (offset < total && offset < hardCap) {
    const url =
      "https://api.mercadolibre.com/orders/search" +
      `?seller=${encodeURIComponent(String(sellerId))}` +
      `&order.status=${encodeURIComponent(String(status || "paid"))}` +
      `&${dateField}.from=${encodeURIComponent(fromISO)}` +
      `&${dateField}.to=${encodeURIComponent(toISO)}` +
      "&sort=date_desc" +
      `&limit=${limit}` +
      `&offset=${offset}`;

    const data = await httpGetJson(url, accessToken, 1);
    const results = Array.isArray(data?.results) ? data.results : [];
    orders.push(...results);

    const pagingTotal = Number(data?.paging?.total ?? results.length);
    total = Number.isFinite(pagingTotal) ? pagingTotal : orders.length;
    if (results.length < limit) break;
    offset += limit;
  }

  return orders;
}

function uniqueOrdersById(orders = []) {
  const out = [];
  const seen = new Set();
  for (const order of orders) {
    const orderId = String(order?.id || "").trim();
    if (!orderId || seen.has(orderId)) continue;
    seen.add(orderId);
    out.push(order);
  }
  return out;
}

async function fetchOrdersByStatuses(
  accessToken,
  sellerId,
  statuses = [],
  fromISO,
  toISO,
  hardCap = 5000,
  dateField = "order.date_closed",
) {
  const normalized = Array.from(
    new Set(
      (statuses || [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
  if (!normalized.length) return [];

  const batches = await Promise.all(
    normalized.map((status) =>
      fetchOrdersByStatus(
        accessToken,
        sellerId,
        status,
        fromISO,
        toISO,
        hardCap,
        dateField,
      ),
    ),
  );

  return uniqueOrdersById(batches.flat());
}

async function fetchActiveItemIds(accessToken, sellerId, hardCap = 10000) {
  const ids = [];
  const limit = 100;
  let cursor = null;
  let totalFetched = 0;

  while (totalFetched < hardCap) {
    const url = new URL(
      `https://api.mercadolibre.com/users/${encodeURIComponent(String(sellerId))}/items/search`,
    );

    url.searchParams.set("status", "active");
    url.searchParams.set("search_type", "scan");
    url.searchParams.set("limit", String(limit));

    if (cursor) {
      url.searchParams.set("scroll_id", cursor);
    }

    const data = await httpGetJson(url.toString(), accessToken, 1);
    const results = Array.isArray(data?.results) ? data.results : [];

    if (!results.length) break;

    ids.push(...results.map((value) => String(value)).filter(Boolean));
    totalFetched = ids.length;

    const nextCursor =
      String(
        data?.scroll_id ||
          data?.paging?.scroll_id ||
          data?.paging?.next_scroll_id ||
          "",
      ).trim() || null;

    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }

  return Array.from(new Set(ids)).slice(0, hardCap);
}

async function fetchActiveItemsTotal(accessToken, sellerId) {
  const url =
    `https://api.mercadolibre.com/users/${encodeURIComponent(String(sellerId))}/items/search` +
    `?status=active&limit=1&offset=0`;

  const data = await httpGetJson(url, accessToken, 1);
  const results = Array.isArray(data?.results) ? data.results : [];
  const pagingTotal = Number(data?.paging?.total);

  return {
    total: Number.isFinite(pagingTotal) ? pagingTotal : results.length,
  };
}

function estimateSaleFeeForOrderItem(orderItem = {}) {
  const quantity = Math.max(1, numberOrZero(orderItem?.quantity || 1));
  const directCandidates = [
    orderItem?.sale_fee,
    orderItem?.listing_fee,
    orderItem?.sale_fee_amount,
    orderItem?.listing_fee_amount,
    orderItem?.fees?.sale_fee,
    orderItem?.fees?.listing_fee,
    orderItem?.charges?.sale_fee,
    orderItem?.charges?.listing_fee,
  ].map(numberOrZero);

  const positiveDirect = directCandidates.find((value) => value > 0);
  if (positiveDirect > 0) return positiveDirect;

  const unitCandidates = [
    orderItem?.unit_sale_fee,
    orderItem?.unit_listing_fee,
    orderItem?.fees?.unit_sale_fee,
    orderItem?.fees?.unit_listing_fee,
  ].map(numberOrZero);

  const positiveUnit = unitCandidates.find((value) => value > 0);
  if (positiveUnit > 0) return positiveUnit * quantity;

  return 0;
}

function orderItems(order) {
  return Array.isArray(order?.order_items) ? order.order_items : [];
}

function orderItemGross(orderItem = {}) {
  const quantity = Math.max(1, numberOrZero(orderItem?.quantity || 1));

  const effectiveUnitPrice = numberOrZero(
    orderItem?.unit_price || orderItem?.full_unit_price,
  );
  if (effectiveUnitPrice > 0) {
    return effectiveUnitPrice * quantity;
  }

  const grossPrice = numberOrZero(orderItem?.gross_price);
  if (grossPrice > 0) return grossPrice;

  return 0;
}

function getCommercialOrderRevenue(order = {}) {
  const gross = orderItems(order).reduce(
    (sum, item) => sum + orderItemGross(item),
    0,
  );
  if (gross > 0) return gross;

  return (
    numberOrZero(order?.total_amount) ||
    numberOrZero(order?.paid_amount) ||
    numberOrZero(order?.payments?.[0]?.total_paid_amount)
  );
}

function buildSeries(from, to, orders) {
  const days = diffDaysInclusive(from, to);
  const points = Array.from({ length: days }).map((_, idx) => {
    const date = addDays(from, idx);
    return { date, revenue: 0, orders: 0, units: 0 };
  });
  const indexByDate = new Map(points.map((point, idx) => [point.date, idx]));

  for (const order of orders) {
    const dateRaw = String(
      order?.date_closed || order?.date_created || "",
    ).slice(0, 10);
    const idx = indexByDate.get(dateRaw);
    if (idx == null) continue;

    const amount = getCommercialOrderRevenue(order);

    const items = orderItems(order);
    const units = items.reduce(
      (acc, item) => acc + numberOrZero(item?.quantity),
      0,
    );

    points[idx].revenue += amount;
    points[idx].orders += 1;
    points[idx].units += units;
  }

  return points;
}

function summarizeOrders(from, to, orders) {
  let revenue = 0;
  let ordersCount = 0;
  let units = 0;
  let fees = 0;
  let feeItemsObserved = 0;
  const soldItemIds = new Set();
  const uniqueItemIds = new Set();

  for (const order of orders) {
    ordersCount += 1;
    const amount = getCommercialOrderRevenue(order);
    revenue += amount;

    const items = orderItems(order);
    for (const item of items) {
      units += numberOrZero(item?.quantity);
      const estimatedFee = estimateSaleFeeForOrderItem(item);
      fees += estimatedFee;
      if (estimatedFee > 0) feeItemsObserved += 1;
      const itemId = String(item?.item?.id || item?.item_id || "").trim();
      if (itemId) {
        soldItemIds.add(itemId);
        uniqueItemIds.add(itemId);
      }
    }
  }

  const days = diffDaysInclusive(from, to);
  const avgDaily = revenue / Math.max(1, days);
  const ticket = revenue / Math.max(1, ordersCount);
  const projectedMonth = avgDaily * daysInMonthFromISO(to);

  return {
    revenue,
    orders_count: ordersCount,
    units_sold: units,
    avg_daily_revenue: avgDaily,
    ticket_medio: ticket,
    projected_month: projectedMonth,
    fees,
    fee_items_observed: feeItemsObserved,
    sold_item_ids: Array.from(soldItemIds),
    unique_items_sold: uniqueItemIds.size,
    series: buildSeries(from, to, orders),
  };
}

function normalizeBillingDetailRows(payload) {
  const rows = [];
  if (Array.isArray(payload?.details)) rows.push(...payload.details);
  if (Array.isArray(payload?.results)) {
    for (const result of payload.results) {
      if (Array.isArray(result?.details)) {
        rows.push(...result.details);
      } else if (result && typeof result === "object") {
        rows.push(result);
      }
    }
  }
  if (!rows.length && payload && typeof payload === "object") {
    rows.push(payload);
  }
  return rows;
}

function getBillingDetailOrderId(row) {
  return String(
    pick(
      row,
      "order_id",
      "order.id",
      "external_order_id",
      "order_info.0.order_id",
      "order_info.order_id",
      "sales_info.0.order_id",
      "sales_info.order_id",
    ) || "",
  ).trim();
}

function isFeeLikeEntry(entry = {}) {
  const signal = lower(
    [
      entry?.type,
      entry?.charge_type,
      entry?.detail,
      entry?.label,
      entry?.name,
      entry?.description,
      entry?.concept,
      entry?.reason,
      entry?.category,
    ]
      .filter(Boolean)
      .join(" "),
  );

  return [
    "fee",
    "tarifa",
    "commission",
    "comissao",
    "listing",
    "sale_fee",
    "listing_fee",
    "marketplace",
    "meli_fee",
    "ml_fee",
  ].some((term) => signal.includes(term));
}

function extractFeeLikeAmount(entry = {}) {
  const direct = [
    pick(entry, "sale_fee_amount"),
    pick(entry, "listing_fee_amount"),
    pick(entry, "marketplace_fee_amount"),
    pick(entry, "marketplace_fee"),
    pick(entry, "commission_amount"),
    pick(entry, "fee_amount"),
    pick(entry, "charged_amount"),
    pick(entry, "amount"),
    pick(entry, "cost"),
  ]
    .map(numberOrZero)
    .find((value) => value > 0);

  return direct || 0;
}

function extractBillingFeeAmount(row = {}) {
  const directCandidates = [
    pick(row, "sale_fee_amount"),
    pick(row, "listing_fee_amount"),
    pick(row, "marketplace_fee_amount"),
    pick(row, "marketplace_fee"),
    pick(row, "commission_amount"),
    pick(row, "fee_amount"),
    pick(row, "charged_amount"),
  ].map(numberOrZero);

  const direct = directCandidates.find((value) => value > 0);
  if (direct > 0) return direct;

  const sumFeeEntries = (arr) =>
    Array.isArray(arr)
      ? arr.reduce((sum, entry) => {
          if (!isFeeLikeEntry(entry)) return sum;
          return sum + extractFeeLikeAmount(entry);
        }, 0)
      : 0;

  return (
    sumFeeEntries(row?.costs) +
    sumFeeEntries(row?.charges) +
    sumFeeEntries(row?.fees) +
    sumFeeEntries(row?.results)
  );
}

async function fetchBillingFeesByOrderIds(orderIds = [], accessToken) {
  const ids = Array.from(
    new Set(
      (orderIds || [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
  if (!ids.length) return new Map();

  const out = new Map();
  for (const chunk of chunkArray(ids, 40)) {
    const url = new URL(BILLING_ORDER_DETAILS_URL);
    url.searchParams.set("order_ids", chunk.join(","));
    url.searchParams.set("sort_by", "DATE");
    url.searchParams.set("order_by", "ASC");

    const payload = await httpGetJson(url.toString(), accessToken, 1);
    const rows = normalizeBillingDetailRows(payload);
    for (const row of rows) {
      const orderId = getBillingDetailOrderId(row);
      if (!orderId) continue;
      const fee = extractBillingFeeAmount(row);
      if (fee <= 0) continue;
      out.set(orderId, numberOrZero(out.get(orderId)) + fee);
    }
  }

  return out;
}

function enrichFeesWithBilling(orders = [], billingFeeByOrderId = new Map()) {
  let fees = 0;
  let resolvedOrders = 0;
  const unresolvedOrderIds = [];

  for (const order of orders) {
    const orderId = String(order?.id || "").trim();
    const inlineFee = Array.isArray(order?.order_items)
      ? order.order_items.reduce(
          (sum, item) => sum + estimateSaleFeeForOrderItem(item),
          0,
        )
      : 0;
    const billingFee = numberOrZero(billingFeeByOrderId.get(orderId));
    const finalFee = inlineFee > 0 ? inlineFee : billingFee;

    if (finalFee > 0) {
      fees += finalFee;
      resolvedOrders += 1;
    } else {
      unresolvedOrderIds.push(orderId || "(sem-id)");
    }
  }

  return {
    fees,
    resolved_orders: resolvedOrders,
    unresolved_order_ids: unresolvedOrderIds,
  };
}

function wrapSourceError(sourceLabel, error, statusCode = 502) {
  const prefix = `[${sourceLabel}]`;
  const baseMessage = error?.message || String(error);
  const wrapped = new Error(
    baseMessage.startsWith(prefix) ? baseMessage : `${prefix} ${baseMessage}`,
  );
  wrapped.statusCode = error?.statusCode || error?.httpStatus || statusCode;
  wrapped.cause = error;
  return wrapped;
}

function buildTimeoutError(sourceLabel, timeoutMs) {
  const err = new Error(
    `${sourceLabel} excedeu o tempo limite de ${Math.round(timeoutMs / 1000)}s.`,
  );
  err.statusCode = 504;
  err.code = "SOURCE_TIMEOUT";
  return err;
}

async function withTimeout(promise, timeoutMs, sourceLabel = "Fonte") {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return promise;

  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(buildTimeoutError(sourceLabel, ms)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function safeSource(
  sourceLabel,
  promise,
  fallback,
  logger = console,
  timeoutMs = 0,
) {
  try {
    return await withTimeout(promise, timeoutMs, sourceLabel);
  } catch (error) {
    logger?.warn?.(`[Painel] ${sourceLabel}:`, error?.message || error);
    return fallback;
  }
}

async function safeSourceResult(
  sourceLabel,
  promise,
  fallback,
  logger = console,
  timeoutMs = 0,
) {
  try {
    const data = await withTimeout(promise, timeoutMs, sourceLabel);
    return { data, available: true, error: null };
  } catch (error) {
    logger?.warn?.(`[Painel] ${sourceLabel}:`, error?.message || error);
    return {
      data: fallback,
      available: false,
      error: error?.message || String(error || "Fonte indisponivel."),
    };
  }
}

async function fetchAdsSummary(options = {}, dateFrom, dateTo) {
  const result = await ProductAdsService.obterResumoCampanhas(
    { date_from: dateFrom, date_to: dateTo },
    options,
  );

  if (!result?.success) {
    throw wrapSourceError(
      "Product Ads",
      new Error(result?.error || "Falha ao buscar campanhas."),
      502,
    );
  }

  const campaigns = Array.isArray(result?.campaigns) ? result.campaigns : [];
  const aggregated = campaigns.reduce(
    (acc, campaign) => {
      const metrics = campaign?.metrics || campaign?.metrics_summary || {};
      const amount = numberOrZero(metrics.total_amount);
      const cost = numberOrZero(metrics.cost);
      const roas = cost > 0 ? amount / cost : 0;
      const acos =
        numberOrZero(metrics.acos) || (amount > 0 ? (cost / amount) * 100 : 0);
      const isActive = lower(campaign?.status) === "active";

      acc.total_campaigns += 1;
      if (isActive) acc.active_campaigns += 1;
      acc.clicks += numberOrZero(metrics.clicks);
      acc.prints += numberOrZero(metrics.prints);
      acc.cost += cost;
      acc.amount += amount;
      acc.units += numberOrZero(metrics.units_quantity);
      acc.acos_high = Math.max(acc.acos_high, acos);
      acc.acos_low = acc.acos_low == null ? acos : Math.min(acc.acos_low, acos);
      acc.roas = acc.cost > 0 ? acc.amount / acc.cost : 0;
      if (isActive && roas > 0) {
        acc.roas_min = acc.roas_min == null ? roas : Math.min(acc.roas_min, roas);
      }
      return acc;
    },
    {
      total_campaigns: 0,
      active_campaigns: 0,
      clicks: 0,
      prints: 0,
      cost: 0,
      amount: 0,
      units: 0,
      acos_high: 0,
      acos_low: null,
      roas: 0,
      roas_min: null,
    },
  );

  return {
    success: true,
    ...aggregated,
    advertiser_id: result?.advertiser_id || null,
    site_id: result?.site_id || null,
  };
}

function extractTotalVisits(payload = {}) {
  const direct = [
    payload?.total_visits,
    payload?.total,
    payload?.visits_total,
    payload?.paging?.total,
  ]
    .map(numberOrZero)
    .find((value) => value > 0);

  if (direct > 0) return direct;

  const sumRows = (rows = []) =>
    rows.reduce(
      (sum, row) =>
        sum +
        numberOrZero(
          row?.total_visits ?? row?.visits_total ?? row?.visits ?? row?.total,
        ),
      0,
    );

  if (Array.isArray(payload?.results)) return sumRows(payload.results);
  if (Array.isArray(payload?.visits_detail)) return sumRows(payload.visits_detail);
  if (Array.isArray(payload?.visits)) return sumRows(payload.visits);

  return 0;
}

async function fetchUserVisits(accessToken, sellerId, dateFrom, dateTo) {
  const url = new URL(
    `https://api.mercadolibre.com/users/${encodeURIComponent(
      String(sellerId),
    )}/items_visits`,
  );
  url.searchParams.set("date_from", dateFrom);
  url.searchParams.set("date_to", dateTo);

  const payload = await httpGetJson(url.toString(), accessToken, 1);
  return {
    total: extractTotalVisits(payload),
    raw: payload,
  };
}

function getSellerTier(sellerReputation = {}) {
  const medal = lower(sellerReputation?.power_seller_status);
  const level = lower(sellerReputation?.level_id);

  if (medal.includes("platinum")) return "platinum";
  if (medal.includes("gold")) return "gold";
  if (medal.includes("leader") || medal.includes("lider")) return "leader";
  if (level === "5_green") return "green";
  return "default";
}

function normalizeMetricPercent(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  if (n > 0 && n <= 1) return n * 100;
  return n;
}

function metricValue(metric = {}) {
  if (typeof metric?.rate === "number")
    return normalizeMetricPercent(metric.rate);
  if (typeof metric?.percent === "number")
    return normalizeMetricPercent(metric.percent);
  if (typeof metric?.value === "number" && typeof metric?.rate !== "number") {
    return normalizeMetricPercent(metric.value);
  }
  return 0;
}

function metricAmount(metric = {}) {
  return Number(metric?.value || metric?.count || metric?.amount || 0);
}

function normalizeExposurePayload(payload = {}) {
  const ids = Array.isArray(payload?.results) ? payload.results : [];
  return {
    total: Number(payload?.paging?.total || ids.length || 0),
    items: ids.slice(0, 20),
  };
}

function buildReputationScore(reputation = {}) {
  const level = lower(reputation?.seller?.reputation_level_id);
  if (level.includes("green"))
    return { value: 8.8, label: "Saudavel", position: 86 };
  if (level.includes("yellow"))
    return { value: 6.3, label: "Atencao", position: 62 };
  if (level.includes("orange"))
    return { value: 4.5, label: "Risco", position: 42 };
  if (level.includes("red"))
    return { value: 2.8, label: "Critico", position: 22 };
  return { value: 7.2, label: "Monitorar", position: 70 };
}

async function fetchLightReputation(accessToken, sellerId) {
  const [user, exposureUnhealthy, exposureWarning] = await Promise.all([
    httpGetJson(
      `https://api.mercadolibre.com/users/${encodeURIComponent(String(sellerId))}`,
      accessToken,
      1,
    ),
    httpGetJson(
      `https://api.mercadolibre.com/users/${encodeURIComponent(String(sellerId))}/items/search?reputation_health_gauge=unhealthy&limit=20`,
      accessToken,
      1,
    ),
    httpGetJson(
      `https://api.mercadolibre.com/users/${encodeURIComponent(String(sellerId))}/items/search?reputation_health_gauge=warning&limit=20`,
      accessToken,
      1,
    ),
  ]);

  const sellerReputation = user?.seller_reputation || {};
  const tier = getSellerTier(sellerReputation);
  const limits = LIMITS_BY_TIER[tier] || LIMITS_BY_TIER.default;
  const metrics = sellerReputation?.metrics || {};
  const exposure = {
    unhealthy: normalizeExposurePayload(exposureUnhealthy),
    warning: normalizeExposurePayload(exposureWarning),
  };
  const totalRisks =
    numberOrZero(exposure.warning.total) +
    numberOrZero(exposure.unhealthy.total);

  return {
    seller: {
      id: sellerId || null,
      nickname: user?.nickname || "-",
      reputation_level_id: sellerReputation?.level_id || null,
      power_seller_status: sellerReputation?.power_seller_status || null,
      transactions: sellerReputation?.transactions || null,
      metrics,
      tier,
      limits,
      metric_cards: {
        claims: {
          value: metricValue(metrics?.claims),
          count: metricAmount(metrics?.claims),
          limit: limits.claims,
        },
        mediations: {
          value: metricValue(metrics?.disputes),
          count: metricAmount(metrics?.disputes),
          limit: limits.mediations,
        },
        cancellations: {
          value: metricValue(metrics?.cancellations),
          count: metricAmount(metrics?.cancellations),
          limit: limits.cancellations,
        },
        delayed: {
          value: metricValue(metrics?.delayed_handling_time),
          count: metricAmount(metrics?.delayed_handling_time),
          limit: limits.delayed,
        },
      },
    },
    exposure,
    score: buildReputationScore({
      seller: { reputation_level_id: sellerReputation?.level_id },
    }),
    helper:
      totalRisks > 0
        ? `${totalRisks.toLocaleString("pt-BR")} anuncio(s) com alerta de exposicao`
        : "Sem alertas de exposicao no momento.",
    warnings: [],
  };
}

function inactiveScoreFromSets(
  activeItemIds = [],
  soldItemIds = [],
  knownTotal = 0,
) {
  const activeSet = new Set(
    activeItemIds.map((value) => String(value)).filter(Boolean),
  );
  const soldSet = new Set(
    soldItemIds.map((value) => String(value)).filter(Boolean),
  );
  let inactive = 0;
  for (const itemId of activeSet) {
    if (!soldSet.has(itemId)) inactive += 1;
  }
  const total =
    activeSet.size > 0 ? activeSet.size : Math.max(0, numberOrZero(knownTotal));
  const hasResolvedBase = activeSet.size > 0 || total === 0;
  const score = hasResolvedBase && total > 0 ? inactive / total : null;

  return {
    inactive: hasResolvedBase ? inactive : null,
    total,
    score,
    points_label:
      score == null
        ? "--"
        : score.toLocaleString("pt-BR", {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          }),
    partial: !hasResolvedBase && total > 0,
  };
}

function buildFinance(
  ordersSummary = {},
  adsSummary = {},
  financeSummary = {},
) {
  const hasFinanceBase =
    financeSummary &&
    financeSummary.available !== false &&
    Object.prototype.hasOwnProperty.call(financeSummary, "margem_contribuicao");
  const faturamento = numberOrZero(
    financeSummary.faturamento_bruto || ordersSummary.revenue,
  );
  const faturamentoComercial = numberOrZero(
    financeSummary.faturamento_base || ordersSummary.revenue,
  );
  const fees = numberOrZero(financeSummary.taxa_vendas || ordersSummary.fees);
  const shipping = numberOrZero(financeSummary.custo_envio);
  const returnCost = numberOrZero(financeSummary.custo_devolucao);
  const plataforma = fees + shipping + returnCost;
  // Publicidade permanece separada da margem de contribuicao.
  const costs = numberOrZero(adsSummary.cost);
  const taxes = numberOrZero(financeSummary.impostos);
  const productCost = numberOrZero(financeSummary.custo_produto);
  const productAndTaxes = productCost + taxes;
  const couponCost = numberOrZero(financeSummary.cupom_vendedor);
  const margin = hasFinanceBase
    ? numberOrZero(financeSummary.margem_contribuicao)
    : null;
  const adsRevenue = numberOrZero(adsSummary.amount);
  const organicRevenue = Math.max(0, faturamentoComercial - adsRevenue);
  const ordersCount = numberOrZero(financeSummary.orders_count || ordersSummary.orders_count);
  const marginTicket = margin == null ? null : margin / Math.max(1, ordersCount);
  const ratioBase = faturamentoComercial > 0 ? faturamentoComercial : faturamento || 1;
  const costCoverage = numberOrZero(financeSummary.cost_coverage_pct);
  const missingCosts = numberOrZero(financeSummary.missing_cost_lines);

  return {
    available: hasFinanceBase,
    pending: !hasFinanceBase,
    faturamento,
    faturamento_comercial: faturamentoComercial,
    fees,
    shipping,
    return_cost: returnCost,
    plataforma,
    costs,
    taxes,
    product_cost: productCost,
    product_and_taxes: productAndTaxes,
    coupon_cost: couponCost,
    margin,
    ticket: numberOrZero(financeSummary.ticket_medio || ordersSummary.ticket_medio),
    margin_ticket: marginTicket,
    plataforma_pct: ratioBase > 0 ? (plataforma / ratioBase) * 100 : 0,
    costs_pct: ratioBase > 0 ? (costs / ratioBase) * 100 : 0,
    product_and_taxes_pct: ratioBase > 0 ? (productAndTaxes / ratioBase) * 100 : 0,
    coupon_cost_pct: ratioBase > 0 ? (couponCost / ratioBase) * 100 : 0,
    margin_pct: hasFinanceBase
      ? numberOrZero(financeSummary.margem_pct ?? (ratioBase > 0 ? (numberOrZero(margin) / ratioBase) * 100 : 0))
      : null,
    ads_revenue: adsRevenue,
    organic_revenue: organicRevenue,
    cost_coverage_pct: costCoverage,
    missing_cost_lines: missingCosts,
    rebate_informativo: numberOrZero(financeSummary.rebate_informativo),
    cupom_vendedor: numberOrZero(financeSummary.cupom_vendedor),
    helper: hasFinanceBase
      ? missingCosts > 0
        ? `Resumo financeiro carregado com ${costCoverage.toFixed(1).replace(".", ",")}% de cobertura de custos; ${missingCosts} item(ns) vendido(s) estao sem custo.`
        : "Margem conciliada com os custos por SKU e a mesma regra da tela Margem de venda. Publicidade e exibida separadamente."
      : "Calculando CMV, impostos, tarifas e cupons com a mesma regra da tela Margem de venda...",
  };
}

function roundPct(value, digits = 2) {
  const n = numberOrZero(value);
  return Number(n.toFixed(digits));
}

function buildRhythmMetric({
  currentValue = 0,
  previousValue = 0,
  day = 1,
  monthDays = 30,
} = {}) {
  const current = numberOrZero(currentValue);
  const previous = numberOrZero(previousValue);
  const safeDay = Math.max(1, numberOrZero(day));
  const safeMonthDays = Math.max(1, numberOrZero(monthDays));
  const requiredPct = (safeDay / safeMonthDays) * 100;
  const actualPct = previous > 0 ? (current / previous) * 100 : 0;
  const expectedToday = previous * (safeDay / safeMonthDays);
  const difference = current - expectedToday;
  const projection = (current / safeDay) * safeMonthDays;
  const projectionDelta = projection - previous;

  let status = "on_track";
  if (previous <= 0) status = "no_base";
  else if (difference > 0.01) status = "ahead";
  else if (difference < -0.01) status = "behind";

  return {
    status,
    current,
    previous,
    expected_today: expectedToday,
    difference,
    projection,
    projection_delta: projectionDelta,
    actual_pct: roundPct(actualPct, 2),
    required_pct: roundPct(requiredPct, 2),
  };
}

function buildMonthlyRhythm({
  referenceDate,
  currentMonthRevenue = 0,
  previousMonthRevenue = 0,
  currentMonthSales = 0,
  previousMonthSales = 0,
} = {}) {
  const day = Number(String(referenceDate || "").slice(8, 10)) || 1;
  const monthDays = Math.max(1, daysInMonthFromISO(referenceDate || todayISO()));
  const revenue = buildRhythmMetric({
    currentValue: currentMonthRevenue,
    previousValue: previousMonthRevenue,
    day,
    monthDays,
  });
  const sales = buildRhythmMetric({
    currentValue: currentMonthSales,
    previousValue: previousMonthSales,
    day,
    monthDays,
  });

  return {
    status: revenue.status,
    delta_pct: roundPct(revenue.actual_pct - revenue.required_pct, 2),
    actual_pct: revenue.actual_pct,
    required_pct: revenue.required_pct,
    current_month_revenue: revenue.current,
    previous_month_revenue: revenue.previous,
    reference_day: day,
    days_in_month: monthDays,
    revenue,
    sales,
  };
}

function conversionRate(sales, visits) {
  const safeVisits = numberOrZero(visits);
  if (safeVisits <= 0) return 0;
  return (numberOrZero(sales) / safeVisits) * 100;
}

function buildConversionSummary({
  ordersCurrent = {},
  ordersPrevious = {},
  visitsCurrent = {},
  visitsPrevious = {},
  adsCurrent = {},
  adsPrevious = {},
} = {}) {
  const totalVisits = numberOrZero(visitsCurrent?.total);
  const previousVisits = numberOrZero(visitsPrevious?.total);
  const totalSales = numberOrZero(ordersCurrent?.orders_count);
  const previousSales = numberOrZero(ordersPrevious?.orders_count);

  const adsVisits = Math.min(totalVisits, numberOrZero(adsCurrent?.clicks));
  const adsSales = Math.min(totalSales, numberOrZero(adsCurrent?.units));
  const organicVisits = Math.max(0, totalVisits - adsVisits);
  const organicSales = Math.max(0, totalSales - adsSales);

  const previousAdsVisits = Math.min(
    previousVisits,
    numberOrZero(adsPrevious?.clicks),
  );
  const previousAdsSales = Math.min(
    previousSales,
    numberOrZero(adsPrevious?.units),
  );
  const previousOrganicVisits = Math.max(0, previousVisits - previousAdsVisits);
  const previousOrganicSales = Math.max(0, previousSales - previousAdsSales);

  const rate = conversionRate(totalSales, totalVisits);
  const previousRate = conversionRate(previousSales, previousVisits);
  const organicRate = conversionRate(organicSales, organicVisits);
  const previousOrganicRate = conversionRate(
    previousOrganicSales,
    previousOrganicVisits,
  );
  const adsRate = conversionRate(adsSales, adsVisits);
  const previousAdsRate = conversionRate(previousAdsSales, previousAdsVisits);
  const visitsDeltaPct =
    previousVisits > 0 ? ((totalVisits - previousVisits) / previousVisits) * 100 : 0;

  return {
    total_visits_periodo: totalVisits,
    total_vendas_periodo: totalSales,
    visitas_organico: organicVisits,
    visitas_publicidade: adsVisits,
    vendas_organico: organicSales,
    vendas_publicidade: adsSales,
    conversao_atual: rate,
    conversao_periodo_anterior: previousRate,
    conversao_delta_pp: rate - previousRate,
    organic_conversion: organicRate,
    organic_previous_conversion: previousOrganicRate,
    organic_delta_pp: organicRate - previousOrganicRate,
    ads_conversion: adsRate,
    ads_previous_conversion: previousAdsRate,
    ads_delta_pp: adsRate - previousAdsRate,
    visitas_periodo_anterior: previousVisits,
    vendas_periodo_anterior: previousSales,
    visitas_delta_pct: visitsDeltaPct,
  };
}

async function resolveInactivitySnapshot({
  accessToken,
  sellerId,
  logger = console,
}) {
  const inactivityRange = currentRangeFromPreset("30d");
  const [inactivityOrders, activeItemsSummary, activeItemIds] =
    await Promise.all([
      fetchOrdersByStatuses(
        accessToken,
        sellerId,
        ["paid"],
        isoStartOfDayBR(inactivityRange.date_from),
        isoEndOfDayBR(inactivityRange.date_to),
      ),
      safeSourceResult(
        "Resumo itens ativos",
        fetchActiveItemsTotal(accessToken, sellerId),
        { total: 0 },
        logger,
        SOURCE_TIMEOUT_MS.activeItemsTotal,
      ),
      safeSource(
        "Itens ativos em background",
        fetchActiveItemIds(accessToken, sellerId),
        [],
        logger,
        SOURCE_TIMEOUT_MS.activeItemsBackground,
      ),
    ]);

  const ordersInactivity = summarizeOrders(
    inactivityRange.date_from,
    inactivityRange.date_to,
    inactivityOrders,
  );
  const activeListingsTotal = Math.max(
    numberOrZero(activeItemsSummary?.data?.total),
    Array.isArray(activeItemIds) ? activeItemIds.length : 0,
  );
  const inactivity = inactiveScoreFromSets(
    activeItemIds,
    ordersInactivity.sold_item_ids,
    activeListingsTotal,
  );

  return {
    range: inactivityRange,
    total_active_listings: activeListingsTotal,
    inactivity: {
      ...inactivity,
      label: "Anuncios sem vendas nos ultimos 30 dias",
    },
  };
}

class PainelService {
  static async obterOverview({ preset = "today" } = {}, options = {}) {
    const current = currentRangeFromPreset(preset);
    const previous = buildCompareRange(current);
    const inactivityRange = currentRangeFromPreset("30d");
    const rhythmReferenceDate = todayISO();
    const currentMonthFrom = startOfMonth(rhythmReferenceDate);
    const currentMonthTo = rhythmReferenceDate;
    const previousMonthAnchor = addDays(currentMonthFrom, -1);
    const previousMonthFrom = startOfMonth(previousMonthAnchor);
    const previousMonthTo = endOfMonth(previousMonthAnchor);
    const accessToken = options?.accessToken;
    const logger = options?.logger || console;
    const saleStatuses = ["paid"];

    if (!accessToken) {
      const err = new Error("Token ML indisponivel para consolidar o Painel.");
      err.statusCode = 401;
      throw err;
    }

    const me = await getMe(accessToken);
    const sellerId = me?.id;
    if (!sellerId) {
      const err = new Error("Nao foi possivel identificar o seller atual.");
      err.statusCode = 502;
      throw err;
    }

    const cacheKey = makeCacheKey({
      accountKey: options?.accountKey || options?.accountLabel,
      sellerId,
      preset: current.preset,
    });
    const ttlMs = resolveCacheTtlMs(current.preset);
    const cached = options?.forceRefresh ? null : getCache(cacheKey);
    if (cached) return cached;

    const [
      currentOrdersSource,
      previousOrdersSource,
      currentMonthOrdersSource,
      previousMonthOrdersSource,
      currentCancelledSource,
      previousCancelledSource,
      inactivityOrdersSource,
      activeItemsSource,
      activeItemIdsSource,
      adsResult,
      previousAdsResult,
      visitsCurrentSource,
      visitsPreviousSource,
      reputationSource,
    ] = await Promise.all([
      safeSourceResult(
        "Vendas atuais",
        fetchOrdersByStatuses(
          accessToken,
          sellerId,
          saleStatuses,
          isoStartOfDayBR(current.date_from),
          isoEndOfDayBR(current.date_to),
        ),
        [],
        logger,
        SOURCE_TIMEOUT_MS.orders,
      ),
      safeSourceResult(
        "Vendas comparativas",
        fetchOrdersByStatuses(
          accessToken,
          sellerId,
          saleStatuses,
          isoStartOfDayBR(previous.date_from),
          isoEndOfDayBR(previous.date_to),
        ),
        [],
        logger,
        SOURCE_TIMEOUT_MS.orders,
      ),
      safeSourceResult(
        "Vendas mes atual",
        fetchOrdersByStatuses(
          accessToken,
          sellerId,
          saleStatuses,
          isoStartOfDayBR(currentMonthFrom),
          isoEndOfDayBR(currentMonthTo),
        ),
        [],
        logger,
        SOURCE_TIMEOUT_MS.orders,
      ),
      safeSourceResult(
        "Vendas mes anterior",
        fetchOrdersByStatuses(
          accessToken,
          sellerId,
          saleStatuses,
          isoStartOfDayBR(previousMonthFrom),
          isoEndOfDayBR(previousMonthTo),
        ),
        [],
        logger,
        SOURCE_TIMEOUT_MS.orders,
      ),
      safeSourceResult(
        "Cancelamentos atuais",
        fetchOrdersByStatus(
          accessToken,
          sellerId,
          "cancelled",
          isoStartOfDayBR(current.date_from),
          isoEndOfDayBR(current.date_to),
          1000,
          "order.date_created",
        ),
        [],
        logger,
        SOURCE_TIMEOUT_MS.orders,
      ),
      safeSourceResult(
        "Cancelamentos comparativos",
        fetchOrdersByStatus(
          accessToken,
          sellerId,
          "cancelled",
          isoStartOfDayBR(previous.date_from),
          isoEndOfDayBR(previous.date_to),
          1000,
          "order.date_created",
        ),
        [],
        logger,
        SOURCE_TIMEOUT_MS.orders,
      ),
      safeSourceResult(
        "Vendas para inatividade",
        fetchOrdersByStatuses(
          accessToken,
          sellerId,
          saleStatuses,
          isoStartOfDayBR(inactivityRange.date_from),
          isoEndOfDayBR(inactivityRange.date_to),
        ),
        [],
        logger,
        SOURCE_TIMEOUT_MS.orders,
      ),
      safeSourceResult(
        "Resumo itens ativos",
        fetchActiveItemsTotal(accessToken, sellerId),
        { total: 0 },
        logger,
        SOURCE_TIMEOUT_MS.activeItemsTotal,
      ),
      safeSourceResult(
        "Itens ativos",
        fetchActiveItemIds(accessToken, sellerId),
        [],
        logger,
        SOURCE_TIMEOUT_MS.activeItems,
      ),
      safeSource(
        "Product Ads",
        fetchAdsSummary(
          {
            accessToken,
            mlCreds: options?.mlCreds || {},
            accountKey: options?.accountKey || null,
          },
          current.date_from,
          current.date_to,
        ),
        {
          success: false,
          active_campaigns: 0,
          total_campaigns: 0,
          acos_high: 0,
          acos_low: 0,
          cost: 0,
          amount: 0,
          units: 0,
          prints: 0,
          clicks: 0,
          error: "Product Ads indisponivel no momento.",
        },
        logger,
        SOURCE_TIMEOUT_MS.productAds,
      ),
      safeSource(
        "Product Ads comparativo",
        fetchAdsSummary(
          {
            accessToken,
            mlCreds: options?.mlCreds || {},
            accountKey: options?.accountKey || null,
          },
          previous.date_from,
          previous.date_to,
        ),
        {
          success: false,
          active_campaigns: 0,
          total_campaigns: 0,
          acos_high: 0,
          acos_low: 0,
          cost: 0,
          amount: 0,
          units: 0,
          prints: 0,
          clicks: 0,
          error: "Product Ads comparativo indisponivel no momento.",
        },
        logger,
        SOURCE_TIMEOUT_MS.productAds,
      ),
      safeSourceResult(
        "Visitas atuais",
        fetchUserVisits(
          accessToken,
          sellerId,
          current.date_from,
          current.date_to,
        ),
        { total: 0 },
        logger,
        SOURCE_TIMEOUT_MS.visits,
      ),
      safeSourceResult(
        "Visitas comparativas",
        fetchUserVisits(
          accessToken,
          sellerId,
          previous.date_from,
          previous.date_to,
        ),
        { total: 0 },
        logger,
        SOURCE_TIMEOUT_MS.visits,
      ),
      safeSourceResult(
        "Reputacao",
        fetchLightReputation(accessToken, sellerId),
        {
          seller: { metric_cards: {} },
          score: { value: 7.2, label: "Monitorar", position: 70 },
          helper: "Nao foi possivel carregar a reputacao agora.",
        },
        logger,
        SOURCE_TIMEOUT_MS.reputation,
      ),
    ]);

    const currentOrders = currentOrdersSource.data;
    const previousOrders = previousOrdersSource.data;
    const currentMonthOrders = currentMonthOrdersSource.data;
    const previousMonthOrders = previousMonthOrdersSource.data;
    const currentCancelled = currentCancelledSource.data;
    const previousCancelled = previousCancelledSource.data;
    const inactivityOrders = inactivityOrdersSource.data;
    const activeItemsSummary = activeItemsSource.data;
    const activeItemIds = activeItemIdsSource.data;
    const visitsCurrent = visitsCurrentSource.data;
    const visitsPrevious = visitsPreviousSource.data;
    const reputation = reputationSource.data;

    const sourceStatus = {
      orders_current: currentOrdersSource,
      orders_previous: previousOrdersSource,
      orders_month_current: currentMonthOrdersSource,
      orders_month_previous: previousMonthOrdersSource,
      cancelled_current: currentCancelledSource,
      cancelled_previous: previousCancelledSource,
      inactivity_orders: inactivityOrdersSource,
      active_items: activeItemsSource,
      active_item_ids: activeItemIdsSource,
      visits_current: visitsCurrentSource,
      visits_previous: visitsPreviousSource,
      reputation: reputationSource,
      product_ads: {
        available: !!adsResult?.success,
        error: adsResult?.success ? null : adsResult?.error || "Product Ads indisponivel.",
      },
      product_ads_previous: {
        available: !!previousAdsResult?.success,
        error: previousAdsResult?.success ? null : previousAdsResult?.error || "Comparativo de Product Ads indisponivel.",
      },
      finance_quick: {
        available: null,
        pending: true,
        error: null,
      },
    };
    const hasPartialSources = Object.values(sourceStatus).some(
      (value) => value?.available === false,
    );
    // Payload parcial deve expirar rapido para permitir recuperacao automatica
    // da fonte que falhou sem manter zeros/indisponibilidade por horas.
    const effectiveTtlMs = hasPartialSources ? Math.min(ttlMs, 30000) : ttlMs;

    const ordersCurrent = summarizeOrders(
      current.date_from,
      current.date_to,
      currentOrders,
    );
    const ordersPrevious = summarizeOrders(
      previous.date_from,
      previous.date_to,
      previousOrders,
    );
    const ordersInactivity = summarizeOrders(
      inactivityRange.date_from,
      inactivityRange.date_to,
      inactivityOrders,
    );
    const ordersCurrentMonth = summarizeOrders(
      currentMonthFrom,
      currentMonthTo,
      currentMonthOrders,
    );
    const ordersPreviousMonth = summarizeOrders(
      previousMonthFrom,
      previousMonthTo,
      previousMonthOrders,
    );
    const [currentBillingFees, previousBillingFees] = await Promise.all([
      safeSource(
        "Billing atual",
        fetchBillingFeesByOrderIds(
          currentOrders.map((order) => order?.id),
          accessToken,
        ),
        new Map(),
        logger,
        SOURCE_TIMEOUT_MS.billing,
      ),
      safeSource(
        "Billing comparativo",
        fetchBillingFeesByOrderIds(
          previousOrders.map((order) => order?.id),
          accessToken,
        ),
        new Map(),
        logger,
        SOURCE_TIMEOUT_MS.billing,
      ),
    ]);
    const currentResolvedFees = enrichFeesWithBilling(
      currentOrders,
      currentBillingFees,
    );
    const previousResolvedFees = enrichFeesWithBilling(
      previousOrders,
      previousBillingFees,
    );
    ordersCurrent.fees = currentResolvedFees.fees;
    ordersPrevious.fees = previousResolvedFees.fees;
    const activeListingsTotal = Math.max(
      numberOrZero(activeItemsSummary?.total),
      Array.isArray(activeItemIds) ? activeItemIds.length : 0,
    );
    const inactivity = inactiveScoreFromSets(
      activeItemIds,
      ordersInactivity.sold_item_ids,
      activeListingsTotal,
    );
    const finance = buildFinance(
      ordersCurrent,
      adsResult,
      { available: false },
    );
    const previousFinance = buildFinance(
      ordersPrevious,
      previousAdsResult,
      { available: false },
    );
    const rhythm = buildMonthlyRhythm({
      referenceDate: rhythmReferenceDate,
      currentMonthRevenue: ordersCurrentMonth.revenue,
      previousMonthRevenue: ordersPreviousMonth.revenue,
      currentMonthSales: ordersCurrentMonth.orders_count,
      previousMonthSales: ordersPreviousMonth.orders_count,
    });
    const conversion = buildConversionSummary({
      ordersCurrent,
      ordersPrevious,
      visitsCurrent,
      visitsPrevious,
      adsCurrent: adsResult,
      adsPrevious: previousAdsResult,
    });
    const feeCoverageCurrent =
      ordersCurrent.orders_count > 0
        ? (currentResolvedFees.resolved_orders / ordersCurrent.orders_count) *
          100
        : 100;
    const feeCoveragePrevious =
      ordersPrevious.orders_count > 0
        ? (previousResolvedFees.resolved_orders / ordersPrevious.orders_count) *
          100
        : 100;

    const payload = {
      success: true,
      filters: {
        current: {
          ...current,
          days: diffDaysInclusive(current.date_from, current.date_to),
          month_key: monthKey(current.date_to),
        },
        previous,
        inactivity: inactivityRange,
      },
      account: {
        label:
          options?.accountLabel ||
          options?.accountKey ||
          me?.nickname ||
          "Conta ativa",
        key: options?.accountKey || null,
        seller_id: sellerId,
        site_id: me?.site_id || null,
      },
      quick: {
        avg_daily_revenue: ordersCurrent.avg_daily_revenue,
        projected_month: ordersCurrent.projected_month,
        sync_label: `Atualizado as ${new Date().toLocaleTimeString("pt-BR", {
          hour: "2-digit",
          minute: "2-digit",
        })}`,
        ticket_delta_label:
          ordersCurrent.revenue >= ordersPrevious.revenue
            ? "ritmo acima"
            : "ritmo abaixo",
      },
      overview: {
        active_listings: activeListingsTotal,
        products_count: ordersCurrent.unique_items_sold,
        orders_total: ordersCurrent.orders_count,
        units_total: ordersCurrent.units_sold,
      },
      finance: {
        ...finance,
        previous: previousFinance,
      },
      inactivity: {
        ...inactivity,
        label: "Anuncios sem vendas nos ultimos 30 dias",
      },
      reputation,
      sales_summary: {
        current: {
          orders: ordersCurrent.orders_count,
          cancelled: currentCancelled.length,
          revenue: ordersCurrent.revenue,
        },
        previous: {
          orders: ordersPrevious.orders_count,
          cancelled: previousCancelled.length,
          revenue: ordersPrevious.revenue,
        },
        series: ordersCurrent.series,
      },
      conversion,
      ads: {
        status_label:
          adsResult?.success && adsResult.active_campaigns > 0
            ? "Ativo"
            : "Monitorar",
        active_campaigns: numberOrZero(adsResult?.active_campaigns),
        total_campaigns: numberOrZero(adsResult?.total_campaigns),
        acos_high: numberOrZero(adsResult?.acos_high),
        acos_low: numberOrZero(adsResult?.acos_low),
        roas: numberOrZero(adsResult?.roas),
        roas_min: numberOrZero(adsResult?.roas_min),
        cost: numberOrZero(adsResult?.cost),
        amount: numberOrZero(adsResult?.amount),
        units: numberOrZero(adsResult?.units),
        prints: numberOrZero(adsResult?.prints),
        clicks: numberOrZero(adsResult?.clicks),
        previous: {
          roas: numberOrZero(previousAdsResult?.roas),
          roas_min: numberOrZero(previousAdsResult?.roas_min),
          cost: numberOrZero(previousAdsResult?.cost),
          amount: numberOrZero(previousAdsResult?.amount),
          units: numberOrZero(previousAdsResult?.units),
          prints: numberOrZero(previousAdsResult?.prints),
          clicks: numberOrZero(previousAdsResult?.clicks),
          ctr:
            numberOrZero(previousAdsResult?.prints) > 0
              ? (numberOrZero(previousAdsResult?.clicks) /
                  numberOrZero(previousAdsResult?.prints)) *
                100
              : 0,
        },
        ctr:
          numberOrZero(adsResult?.prints) > 0
            ? (numberOrZero(adsResult?.clicks) /
                numberOrZero(adsResult?.prints)) *
              100
            : 0,
        marketplace_url:
          "https://www.mercadolivre.com.br/advertising/product-ads",
        available: !!adsResult?.success,
        error: adsResult?.success ? null : adsResult?.error || null,
      },
      rhythm,
      meta: {
        updated_at: new Date().toISOString(),
        current_month_start: currentMonthFrom,
        current_month_end: endOfMonth(rhythmReferenceDate),
        cache_ttl_sec: Math.round(effectiveTtlMs / 1000),
        sources: Object.fromEntries(
          Object.entries(sourceStatus).map(([key, value]) => [key, {
            available: value?.available !== false,
            error: value?.available === false ? value?.error || null : null,
          }]),
        ),
        partial: hasPartialSources,
        source_notes: {
          seller: "users/me",
          active_items: "users/{seller_id}/items/search?status=active",
          sales: "orders/search?seller={seller_id}&order.status=paid",
          cancelled: "orders/search?seller={seller_id}&order.status=cancelled",
          visits: "users/{seller_id}/items_visits",
          fees_primary: "orders/search.results[].order_items[].sale_fee",
          fees_enrichment: "billing/integration/group/ML/order/details",
        },
        fees_coverage: {
          current: {
            resolved_orders: currentResolvedFees.resolved_orders,
            total_orders: ordersCurrent.orders_count,
            coverage_pct: Number(feeCoverageCurrent.toFixed(1)),
          },
          previous: {
            resolved_orders: previousResolvedFees.resolved_orders,
            total_orders: ordersPrevious.orders_count,
            coverage_pct: Number(feeCoveragePrevious.toFixed(1)),
          },
        },
      },
    };

    setCache(cacheKey, payload, effectiveTtlMs);
    return payload;
  }

  static async obterFinanceiroRapido({ preset = "today" } = {}, options = {}) {
    const current = currentRangeFromPreset(preset);
    const previous = buildCompareRange(current);
    const context = {
      accessToken: options?.accessToken || null,
      mlCreds: options?.mlCreds || {},
      accountKey: options?.accountKey || null,
      accountLabel: options?.accountLabel || null,
    };
    const refresh = !!options?.forceRefresh;

    const [currentResult, previousResult] = await Promise.all([
      safeSourceResult(
        "Resumo financeiro atual",
        FinanceiroMlService.quickMarginSummary(
          {
            date_from: current.date_from,
            date_to: current.date_to,
            date_field: "closed",
            refresh: refresh ? "1" : "0",
          },
          context,
        ),
        null,
        options?.logger || console,
        SOURCE_TIMEOUT_MS.financeQuick,
      ),
      safeSourceResult(
        "Resumo financeiro comparativo",
        FinanceiroMlService.quickMarginSummary(
          {
            date_from: previous.date_from,
            date_to: previous.date_to,
            date_field: "closed",
            refresh: refresh ? "1" : "0",
          },
          context,
        ),
        null,
        options?.logger || console,
        SOURCE_TIMEOUT_MS.financeQuick,
      ),
    ]);

    if (!currentResult.available || !currentResult.data) {
      const err = new Error(currentResult.error || "Resumo financeiro indisponivel no momento.");
      err.statusCode = 503;
      throw err;
    }

    const currentSummary = { ...currentResult.data, available: true };
    const previousSummary = previousResult.available && previousResult.data
      ? { ...previousResult.data, available: true }
      : { available: false };
    const finance = buildFinance(
      {
        revenue: currentSummary.faturamento_base,
        orders_count: currentSummary.orders_count,
        ticket_medio: currentSummary.ticket_medio,
        fees: currentSummary.taxa_vendas,
      },
      {},
      currentSummary,
    );
    const previousFinance = buildFinance(
      {
        revenue: previousSummary.faturamento_base,
        orders_count: previousSummary.orders_count,
        ticket_medio: previousSummary.ticket_medio,
        fees: previousSummary.taxa_vendas,
      },
      {},
      previousSummary,
    );

    return {
      success: true,
      filters: { current, previous },
      finance: { ...finance, previous: previousFinance },
      meta: {
        current_available: true,
        previous_available: !!previousResult.available,
        previous_error: previousResult.error || null,
        calculated_at: currentSummary.calculated_at || new Date().toISOString(),
      },
    };
  }

  static async obterInatividade(options = {}) {
    const accessToken = options?.accessToken;
    const logger = options?.logger || console;

    if (!accessToken) {
      const err = new Error(
        "Token ML indisponivel para consolidar a inatividade.",
      );
      err.statusCode = 401;
      throw err;
    }

    const me = await getMe(accessToken);
    const sellerId = me?.id;
    if (!sellerId) {
      const err = new Error("Nao foi possivel identificar o seller atual.");
      err.statusCode = 502;
      throw err;
    }

    const cacheKey = makeCacheKey({
      accountKey: options?.accountKey || options?.accountLabel,
      sellerId,
      preset: "inactivity_30d",
    });
    const ttlMs = resolveCacheTtlMs("30d");
    const cached = options?.forceRefresh ? null : getCache(cacheKey);
    if (cached) return cached;

    const snapshot = await resolveInactivitySnapshot({
      accessToken,
      sellerId,
      logger,
    });

    const payload = {
      success: true,
      account: {
        seller_id: sellerId,
        nickname: me?.nickname || "-",
        label: options?.accountLabel || me?.nickname || "-",
        key: options?.accountKey || String(sellerId),
      },
      filters: {
        inactivity: {
          ...snapshot.range,
          days: diffDaysInclusive(
            snapshot.range.date_from,
            snapshot.range.date_to,
          ),
        },
      },
      inactivity: snapshot.inactivity,
      meta: {
        updated_at: new Date().toISOString(),
        cache_ttl_sec: Math.round(ttlMs / 1000),
      },
    };

    setCache(cacheKey, payload, ttlMs);
    return payload;
  }
}

module.exports = PainelService;
