"use strict";

const ShopeeProductService = require("./ShopeeProductService");
const ShopeeProductWriteService = require("./ShopeeProductWriteService");
const {
  listProductsByShopAndItemIds,
} = require("../repositories/analyticsSqlRepository");
const {
  createProductBoostBatch,
  listAdsHourlyEventsForBoostAnalytics,
  listLatestSuccessfulBoostItemIds,
  listOrderEventsForBoostAnalytics,
  listProductBoostBatches,
  listSuccessfulBoostWindows,
} = require("../repositories/boostSqlRepository");

const DEFAULT_HISTORY_LIMIT = 40;
const BOOST_WINDOW_MS = 4 * 60 * 60 * 1000;
const BOOST_OVERVIEW_REMOTE_CHECK_COOLDOWN_MS = (4 * 60 + 10) * 60 * 1000;
const SAO_PAULO_OFFSET = "-03:00";
const OVERVIEW_CACHE_TTL_MS = 15000;
const overviewCache = new Map();
const overviewInFlight = new Map();
const boostCurrentRemoteCheckCache = new Map();

function toBigIntStringOrNull(value) {
  if (value == null || value === "") return null;
  try {
    return BigInt(value).toString();
  } catch (_error) {
    return null;
  }
}

function normalizeItemIds(itemIds = []) {
  return Array.from(
    new Set(
      (Array.isArray(itemIds) ? itemIds : [])
        .map((itemId) => toBigIntStringOrNull(itemId))
        .filter(Boolean),
    ),
  );
}

function chunk(items = [], size = 50) {
  const source = Array.isArray(items) ? items : [];
  const safeSize = Math.max(1, Number(size) || 1);
  const output = [];
  for (let i = 0; i < source.length; i += safeSize) {
    output.push(source.slice(i, i + safeSize));
  }
  return output;
}

function startOfDay(dateLike) {
  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfDay(dateLike) {
  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(23, 59, 59, 999);
  return date;
}

function defaultRange(days = 30) {
  const end = endOfDay(new Date());
  const start = new Date(end);
  start.setDate(start.getDate() - (Math.max(1, Number(days) || 30) - 1));
  start.setHours(0, 0, 0, 0);
  return { start, end };
}

function resolveRange({ dateFrom, dateTo, days = 30 }) {
  const start = dateFrom ? startOfDay(dateFrom) : null;
  const end = dateTo ? endOfDay(dateTo) : null;
  if (start && end && start <= end) {
    return { start, end };
  }
  return defaultRange(days);
}

function toDateKey(dateLike) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(dateLike));
  } catch (_error) {
    return new Date(dateLike).toISOString().slice(0, 10);
  }
}

function addMs(dateLike, ms) {
  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + ms);
}

function parseAdsMetricTimestamp(event) {
  const hour = String(Math.max(0, Number(event?.hour || 0))).padStart(2, "0");
  return new Date(`${String(event?.date || "").slice(0, 10)}T${hour}:00:00${SAO_PAULO_OFFSET}`);
}

function toWindow(payload) {
  const start = payload?.boostStartedAt ? new Date(payload.boostStartedAt) : null;
  const end = payload?.boostWindowEndsAt
    ? new Date(payload.boostWindowEndsAt)
    : start
      ? addMs(start, BOOST_WINDOW_MS)
      : null;

  if (!start || Number.isNaN(start.getTime()) || !end || Number.isNaN(end.getTime())) {
    return null;
  }

  return { start, end };
}

function buildEmptyMetrics() {
  return {
    boosts: 0,
    quantitySold: 0,
    ordersCount: 0,
    gmvCents: 0,
    impressions: 0,
    clicks: 0,
    expense: 0,
    directGmv: 0,
    broadGmv: 0,
  };
}

function normalizeReasonText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function isBumpSlotLimitText(value) {
  const text = normalizeReasonText(value);
  if (!text) return false;
  return (
    text.includes("bump slot limit") ||
    text.includes("slot limit") ||
    text.includes("limite de impulso") ||
    text.includes("limite de impulsionamento")
  );
}

function isSlotLimitReached({ payload = null, failureList = [] } = {}) {
  if (isBumpSlotLimitText(payload?.message)) return true;
  if (isBumpSlotLimitText(payload?.warning)) return true;
  return (Array.isArray(failureList) ? failureList : []).some((entry) =>
    isBumpSlotLimitText(entry?.failed_reason || entry?.failedReason),
  );
}

async function getBoostWindowUsage(shopId) {
  const slotsLimit = 5;
  const now = new Date();
  const windowStart = new Date(now.getTime() - BOOST_WINDOW_MS);
  const successfulWindows = await listSuccessfulBoostWindows(shopId, {
    start: windowStart,
    end: now,
  });

  const validStarts = (Array.isArray(successfulWindows) ? successfulWindows : [])
    .map((entry) => new Date(entry?.boostStartedAt || entry?.createdAt))
    .filter((date) => Number.isFinite(date.getTime()))
    .sort((left, right) => left.getTime() - right.getTime());

  const slotsUsed = validStarts.length;
  const slotsAvailable = Math.max(0, slotsLimit - slotsUsed);

  let nextSlotInSeconds = 0;
  if (slotsUsed >= slotsLimit && validStarts.length) {
    const earliestActive = validStarts[0];
    const nextAvailableAtMs = earliestActive.getTime() + BOOST_WINDOW_MS;
    nextSlotInSeconds = Math.max(
      0,
      Math.ceil((nextAvailableAtMs - Date.now()) / 1000),
    );
  }

  return {
    slotsLimit,
    slotsUsed,
    slotsAvailable,
    nextSlotInSeconds,
  };
}

async function getLastSuccessfulBoostStartedAt(shopId) {
  const now = new Date();
  const lookbackStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const windows = await listSuccessfulBoostWindows(shopId, {
    start: lookbackStart,
    end: now,
  });
  const starts = (Array.isArray(windows) ? windows : [])
    .map((entry) => new Date(entry?.boostStartedAt || entry?.createdAt || 0))
    .filter((date) => Number.isFinite(date.getTime()))
    .sort((left, right) => right.getTime() - left.getTime());
  return starts.length ? starts[0] : null;
}

function shouldUseRemoteBoostCheck({ shopId, force = false, lastBoostAt = null }) {
  if (force) return true;
  const nowMs = Date.now();
  const cacheEntry = boostCurrentRemoteCheckCache.get(String(shopId)) || null;
  const lastCheckedAtMs = Number(cacheEntry?.lastCheckedAtMs || 0);
  const boostGateStartMs = Number(lastBoostAt?.getTime?.() || 0);
  const nextAllowedFromBoostMs = boostGateStartMs
    ? boostGateStartMs + BOOST_OVERVIEW_REMOTE_CHECK_COOLDOWN_MS
    : 0;
  const nextAllowedFromCheckMs = lastCheckedAtMs
    ? lastCheckedAtMs + BOOST_OVERVIEW_REMOTE_CHECK_COOLDOWN_MS
    : 0;
  const nextAllowedAtMs = Math.max(nextAllowedFromBoostMs, nextAllowedFromCheckMs);
  return !nextAllowedAtMs || nowMs >= nextAllowedAtMs;
}

function markRemoteBoostCheck(shopId) {
  boostCurrentRemoteCheckCache.set(String(shopId), {
    lastCheckedAtMs: Date.now(),
  });
}

async function getCurrentBoostedItemsFromLocalWindows(shop) {
  const [windowUsage, successfulWindows] = await Promise.all([
    getBoostWindowUsage(shop.id),
    listSuccessfulBoostWindows(shop.id, {
      start: new Date(Date.now() - BOOST_WINDOW_MS),
      end: new Date(),
    }),
  ]);

  const latestByItemId = new Map();
  for (const entry of Array.isArray(successfulWindows) ? successfulWindows : []) {
    const itemId = toBigIntStringOrNull(entry?.itemId);
    if (!itemId) continue;
    const startedAt = new Date(entry?.boostStartedAt || entry?.createdAt || 0);
    if (!Number.isFinite(startedAt.getTime())) continue;
    const previous = latestByItemId.get(itemId);
    if (!previous || startedAt > previous.startedAt) {
      latestByItemId.set(itemId, { entry, startedAt });
    }
  }

  const itemIds = Array.from(latestByItemId.keys());
  const products = await listProductsByShopAndItemIds(shop.id, itemIds);
  const productByItemId = new Map(
    products.map((product) => [toBigIntStringOrNull(product.itemId), product]),
  );

  const nowMs = Date.now();
  const extraInfoMap = await fetchExtraInfoMap(shop, itemIds);
  const items = itemIds.map((itemId) => {
    const selected = latestByItemId.get(itemId);
    const product = productByItemId.get(itemId) || null;
    const extra = extraInfoMap.get(itemId) || null;
    const startedAtMs = Number(selected?.startedAt?.getTime?.() || 0);
    const endsAtMs = startedAtMs ? startedAtMs + BOOST_WINDOW_MS : 0;
    const coolDownSecond = Math.max(0, Math.ceil((endsAtMs - nowMs) / 1000));
    return {
      itemId,
      coolDownSecond,
      coolDownMinutes: Number((coolDownSecond / 60).toFixed(1)),
      title: product?.title || `Item ${itemId}`,
      imageUrl: product?.images?.[0]?.url || null,
      status: product?.status || null,
      costCents: product?.costCents || 0,
      views30d: Math.max(0, Number(extra?.views || 0)),
      impressions30d: Math.max(0, Number(extra?.views || 0)),
      likes30d: Math.max(0, Number(extra?.likes || 0)),
    };
  });

  return {
    items,
    slotsLimit: Number(windowUsage?.slotsLimit || 5),
    slotsUsed: Number(windowUsage?.slotsUsed || 0),
    slotsAvailable: Number(windowUsage?.slotsAvailable || 0),
    nextSlotInSeconds: Number(windowUsage?.nextSlotInSeconds || 0),
    maxCooldownInSeconds: Number(windowUsage?.nextSlotInSeconds || 0),
  };
}

async function getCurrentBoostedItems(shop) {
  const [payload, windowUsage] = await Promise.all([
    ShopeeProductService.getBoostedList({
      shopId: String(shop.shopId),
    }),
    getBoostWindowUsage(shop.id),
  ]);

  const itemList = Array.isArray(payload?.response?.item_list) ? payload.response.item_list : [];
  const itemIds = normalizeItemIds(itemList.map((item) => item?.item_id));
  const products = await listProductsByShopAndItemIds(shop.id, itemIds);
  const productByItemId = new Map(
    products.map((product) => [toBigIntStringOrNull(product.itemId), product]),
  );

  const extraInfoMap = await fetchExtraInfoMap(shop, itemIds);
  const items = itemList.map((item) => {
    const itemId = toBigIntStringOrNull(item?.item_id);
    const product = productByItemId.get(itemId) || null;
    const extra = extraInfoMap.get(itemId) || null;
    const coolDownSecond = Number(item?.cool_down_second || 0);

    return {
      itemId,
      coolDownSecond,
      coolDownMinutes: Number((coolDownSecond / 60).toFixed(1)),
      title: product?.title || `Item ${itemId}`,
      imageUrl: product?.images?.[0]?.url || null,
      status: product?.status || null,
      costCents: product?.costCents || 0,
      views30d: Math.max(0, Number(extra?.views || 0)),
      impressions30d: Math.max(0, Number(extra?.views || 0)),
      likes30d: Math.max(0, Number(extra?.likes || 0)),
    };
  });

  return {
    items,
    slotsLimit: Number(windowUsage?.slotsLimit || 5),
    slotsUsed: Number(windowUsage?.slotsUsed || 0),
    slotsAvailable: Number(windowUsage?.slotsAvailable || 0),
    nextSlotInSeconds: Number(windowUsage?.nextSlotInSeconds || 0),
    maxCooldownInSeconds: Number(windowUsage?.nextSlotInSeconds || 0),
  };
}

async function getSafeCurrentBoostedItems(shop, options = {}) {
  const { forceRemote = false } = options || {};
  try {
    const lastBoostAt = await getLastSuccessfulBoostStartedAt(shop.id);
    const canUseRemote = shouldUseRemoteBoostCheck({
      shopId: shop.id,
      force: forceRemote,
      lastBoostAt,
    });
    if (canUseRemote) {
      const current = await getCurrentBoostedItems(shop);
      markRemoteBoostCheck(shop.id);
      return current;
    }
    return await getCurrentBoostedItemsFromLocalWindows(shop);
  } catch (_error) {
    const windowUsage = await getBoostWindowUsage(shop.id).catch(() => null);
    return {
      items: [],
      slotsLimit: Number(windowUsage?.slotsLimit || 5),
      slotsUsed: Number(windowUsage?.slotsUsed || 0),
      slotsAvailable: Number(windowUsage?.slotsAvailable ?? 5),
      nextSlotInSeconds: Number(windowUsage?.nextSlotInSeconds || 0),
      maxCooldownInSeconds: Number(windowUsage?.nextSlotInSeconds || 0),
    };
  }
}

function computeMetricsForWindow(windowEntry, orderEventsByItemId, adsEventsByItemId) {
  const itemId = windowEntry.itemId;
  const range = toWindow(windowEntry);
  const baseMetrics = buildEmptyMetrics();
  if (!itemId || !range) return baseMetrics;

  const orderEvents = orderEventsByItemId.get(itemId) || [];
  const matchingOrders = orderEvents.filter((event) => {
    const soldAt = new Date(event.soldAt);
    if (Number.isNaN(soldAt.getTime())) return false;
    return soldAt >= range.start && soldAt <= range.end;
  });

  const uniqueOrderIds = new Set(matchingOrders.map((event) => Number(event.orderId)));
  baseMetrics.quantitySold = matchingOrders.reduce(
    (sum, event) => sum + Number(event.quantity || 0),
    0,
  );
  baseMetrics.ordersCount = uniqueOrderIds.size;
  baseMetrics.gmvCents = matchingOrders.reduce(
    (sum, event) => sum + Number(event.gmvCents || 0),
    0,
  );

  const adsEvents = adsEventsByItemId.get(itemId) || [];
  const matchingAds = adsEvents.filter((event) => {
    const metricAt = parseAdsMetricTimestamp(event);
    if (Number.isNaN(metricAt.getTime())) return false;
    return metricAt >= range.start && metricAt <= range.end;
  });

  baseMetrics.impressions = matchingAds.reduce(
    (sum, event) => sum + Number(event.impression || 0),
    0,
  );
  baseMetrics.clicks = matchingAds.reduce(
    (sum, event) => sum + Number(event.click || 0),
    0,
  );
  baseMetrics.expense = matchingAds.reduce(
    (sum, event) => sum + Number(event.expense || 0),
    0,
  );
  baseMetrics.directGmv = matchingAds.reduce(
    (sum, event) => sum + Number(event.directGmv || 0),
    0,
  );
  baseMetrics.broadGmv = matchingAds.reduce(
    (sum, event) => sum + Number(event.broadGmv || 0),
    0,
  );

  return baseMetrics;
}

async function fetchExtraInfoMap(shop, itemIds = []) {
  const normalizedIds = normalizeItemIds(itemIds);
  if (!normalizedIds.length) return new Map();
  const map = new Map();

  for (const batch of chunk(normalizedIds, 50)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await ShopeeProductService.getItemExtraInfoBatch({
        shopId: String(shop.shopId),
        itemIdList: batch,
      });
      const list = Array.isArray(response?.response?.item_list)
        ? response.response.item_list
        : [];
      for (const row of list) {
        const itemId = toBigIntStringOrNull(row?.item_id);
        if (!itemId) continue;
        map.set(itemId, {
          views: Number(row?.views || 0),
          likes: Number(row?.likes || 0),
          sale: Number(row?.sale || 0),
        });
      }
    } catch (_error) {
      continue;
    }
  }

  return map;
}

function addMetrics(target, metrics) {
  target.boosts += Number(metrics?.boosts || 0);
  target.quantitySold += Number(metrics?.quantitySold || 0);
  target.ordersCount += Number(metrics?.ordersCount || 0);
  target.gmvCents += Number(metrics?.gmvCents || 0);
  target.impressions += Number(metrics?.impressions || 0);
  target.clicks += Number(metrics?.clicks || 0);
  target.expense += Number(metrics?.expense || 0);
  target.directGmv += Number(metrics?.directGmv || 0);
  target.broadGmv += Number(metrics?.broadGmv || 0);
  return target;
}

function makeOverviewCacheKey({ shop, range }) {
  return [
    String(shop?.id || ""),
    toDateKey(range?.start),
    toDateKey(range?.end),
  ].join("|");
}

function getCachedOverview(key) {
  const cached = overviewCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    overviewCache.delete(key);
    return null;
  }
  return cached.value;
}

function setCachedOverview(key, value) {
  overviewCache.set(key, {
    value,
    expiresAt: Date.now() + OVERVIEW_CACHE_TTL_MS,
  });
}

function clearOverviewCacheForShop(shopId) {
  const prefix = `${String(shopId)}|`;
  Array.from(overviewCache.keys()).forEach((key) => {
    if (key.startsWith(prefix)) overviewCache.delete(key);
  });
}

async function buildHistoryAndAnalytics({ shop, range, historyLimit = DEFAULT_HISTORY_LIMIT }) {
  const history = await listProductBoostBatches(shop.id, { limit: historyLimit });
  const windows = history.flatMap((batch) =>
    (Array.isArray(batch.items) ? batch.items : [])
      .filter((item) => item?.success)
      .map((item) => ({
        ...item,
        batchId: batch.id,
        batchCreatedAt: batch.createdAt,
      })),
  );

  if (!windows.length) {
    return {
      history,
      summary: buildEmptyMetrics(),
      ranking: [],
      trend: [],
    };
  }

  const minWindowStart = windows.reduce((min, entry) => {
    const rangeEntry = toWindow(entry);
    if (!rangeEntry) return min;
    return !min || rangeEntry.start < min ? rangeEntry.start : min;
  }, null);
  const maxWindowEnd = windows.reduce((max, entry) => {
    const rangeEntry = toWindow(entry);
    if (!rangeEntry) return max;
    return !max || rangeEntry.end > max ? rangeEntry.end : max;
  }, null);

  const allItemIds = normalizeItemIds(windows.map((entry) => entry.itemId));
  let orderEvents = [];
  let adsEvents = [];
  try {
    [orderEvents, adsEvents] = await Promise.all([
      listOrderEventsForBoostAnalytics(shop.id, allItemIds, {
        start: minWindowStart,
        end: maxWindowEnd,
      }),
      listAdsHourlyEventsForBoostAnalytics(shop.id, allItemIds, {
        dateFrom: toDateKey(minWindowStart),
        dateTo: toDateKey(maxWindowEnd),
      }),
    ]);
  } catch (error) {
    console.warn("[boost] Falha ao carregar analytics do boost, retornando historico sem metricas:", error?.message || error);
  }

  const orderEventsByItemId = new Map();
  orderEvents.forEach((event) => {
    if (!orderEventsByItemId.has(event.itemId)) orderEventsByItemId.set(event.itemId, []);
    orderEventsByItemId.get(event.itemId).push(event);
  });

  const adsEventsByItemId = new Map();
  adsEvents.forEach((event) => {
    if (!adsEventsByItemId.has(event.itemId)) adsEventsByItemId.set(event.itemId, []);
    adsEventsByItemId.get(event.itemId).push(event);
  });

  const rangeStart = range.start;
  const rangeEnd = range.end;
  const rankingMap = new Map();
  const trendMap = new Map();
  const metricsByBatchItemId = new Map();
  const overallSummary = buildEmptyMetrics();

  windows.forEach((windowEntry) => {
    const metrics = computeMetricsForWindow(windowEntry, orderEventsByItemId, adsEventsByItemId);
    metrics.boosts = 1;
    metricsByBatchItemId.set(windowEntry.id, metrics);

    const boostWindow = toWindow(windowEntry);
    if (!boostWindow || boostWindow.start < rangeStart || boostWindow.start > rangeEnd) {
      return;
    }

    addMetrics(overallSummary, metrics);

    const rankingKey = windowEntry.itemId;
    if (!rankingMap.has(rankingKey)) {
      rankingMap.set(rankingKey, {
        itemId: rankingKey,
        title: windowEntry.product?.title || `Item ${rankingKey}`,
        imageUrl: windowEntry.product?.imageUrl || null,
        metrics: buildEmptyMetrics(),
      });
    }
    addMetrics(rankingMap.get(rankingKey).metrics, metrics);

    const dayKey = toDateKey(boostWindow.start);
    if (!trendMap.has(dayKey)) {
      trendMap.set(dayKey, {
        date: dayKey,
        boosts: 0,
        quantitySold: 0,
        ordersCount: 0,
        gmvCents: 0,
        clicks: 0,
        impressions: 0,
      });
    }
    const trendEntry = trendMap.get(dayKey);
    trendEntry.boosts += 1;
    trendEntry.quantitySold += metrics.quantitySold;
    trendEntry.ordersCount += metrics.ordersCount;
    trendEntry.gmvCents += metrics.gmvCents;
    trendEntry.clicks += metrics.clicks;
    trendEntry.impressions += metrics.impressions;
  });

  const enrichedHistory = history.map((batch) => {
    const items = (Array.isArray(batch.items) ? batch.items : []).map((item) => ({
      ...item,
      metrics: metricsByBatchItemId.get(item.id) || buildEmptyMetrics(),
    }));
    const batchMetrics = items.reduce((acc, item) => addMetrics(acc, item.metrics), buildEmptyMetrics());
    return {
      ...batch,
      items,
      metrics: batchMetrics,
    };
  });

  const rankingBase = Array.from(rankingMap.values())
    .map((entry) => ({
      itemId: entry.itemId,
      title: entry.title,
      imageUrl: entry.imageUrl,
      boosts: entry.metrics.boosts,
      quantitySold: entry.metrics.quantitySold,
      ordersCount: entry.metrics.ordersCount,
      gmvCents: entry.metrics.gmvCents,
      clicks: entry.metrics.clicks,
      impressions: entry.metrics.impressions,
      expense: entry.metrics.expense,
      directGmv: entry.metrics.directGmv,
      broadGmv: entry.metrics.broadGmv,
    }))
    .sort(
      (left, right) =>
        Number(right.quantitySold || 0) - Number(left.quantitySold || 0) ||
        Number(right.boosts || 0) - Number(left.boosts || 0) ||
        Number(right.clicks || 0) - Number(left.clicks || 0),
    );

  const extraInfoMap = await fetchExtraInfoMap(
    shop,
    rankingBase.map((entry) => entry.itemId),
  );
  const ranking = rankingBase.map((entry) => {
    const extra = extraInfoMap.get(String(entry.itemId)) || null;
    const views = Math.max(0, Number(extra?.views || 0));
    const clicksFromAds = Math.max(0, Number(entry?.clicks || 0));
    return {
      ...entry,
      clicks: clicksFromAds > 0 ? clicksFromAds : views,
      views30d: views,
      impressions30d: views,
      visits30d: views,
      likes30d: Math.max(0, Number(extra?.likes || 0)),
    };
  });

  const trend = Array.from(trendMap.values()).sort((left, right) =>
    String(left.date).localeCompare(String(right.date)),
  );

  return {
    history: enrichedHistory,
    summary: overallSummary,
    ranking,
    trend,
  };
}

async function getOverview({ shop, dateFrom, dateTo }) {
  const range = resolveRange({ dateFrom, dateTo, days: 30 });
  const cacheKey = makeOverviewCacheKey({ shop, range });
  const cached = getCachedOverview(cacheKey);
  if (cached) return cached;

  if (overviewInFlight.has(cacheKey)) {
    return overviewInFlight.get(cacheKey);
  }

  const promise = (async () => {
    const [current, lastSuccessfulItemIds, historyAnalytics] = await Promise.all([
      getSafeCurrentBoostedItems(shop, { forceRemote: false }),
      listLatestSuccessfulBoostItemIds(shop.id),
      buildHistoryAndAnalytics({ shop, range }),
    ]);

    const payload = {
      range: {
        dateFrom: toDateKey(range.start),
        dateTo: toDateKey(range.end),
      },
      current,
      history: historyAnalytics.history,
      summary: historyAnalytics.summary,
      ranking: historyAnalytics.ranking,
      trend: historyAnalytics.trend,
      lastSuccessfulItemIds,
    };

    setCachedOverview(cacheKey, payload);
    return payload;
  })();

  overviewInFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    overviewInFlight.delete(cacheKey);
  }
}

async function runBoost({ shop, userId, itemIds }) {
  const normalizedItemIds = normalizeItemIds(itemIds);
  if (!normalizedItemIds.length) {
    const error = new Error("Informe ao menos um item para impulsionar.");
    error.statusCode = 400;
    throw error;
  }

  if (normalizedItemIds.length > 5) {
    const error = new Error("A Shopee permite impulsionar no mÃ¡ximo 5 IDs por vez.");
    error.statusCode = 400;
    throw error;
  }

  try {
    const result = await ShopeeProductWriteService.boostItems({
      shopId: String(shop.shopId),
      body: {
        item_id_list: normalizedItemIds.map((itemId) => Number(itemId)),
      },
    });

    const successItemIds = normalizeItemIds(result?.response?.success_list?.item_id_list || []);
    const failureList = Array.isArray(result?.response?.failure_list) ? result.response.failure_list : [];

    const batch = await createProductBoostBatch({
      shopId: shop.id,
      userId,
      requestedItemIds: normalizedItemIds,
      requestId: result?.request_id || null,
      warning: result?.warning || null,
      successItemIds,
      failureList,
    });
    clearOverviewCacheForShop(shop.id);

    const [current, lastSuccessfulItemIds] = await Promise.all([
      getSafeCurrentBoostedItems(shop, { forceRemote: true }),
      listLatestSuccessfulBoostItemIds(shop.id),
    ]);

    return {
      ok: successItemIds.length > 0,
      batch,
      result,
      current,
      lastSuccessfulItemIds,
      slotLimitReached: false,
      nextSlotInSeconds: Number(current?.nextSlotInSeconds || 0),
    };
  } catch (error) {
    const payload = error?.shopee || null;
    const failureList =
      Array.isArray(payload?.response?.failure_list) && payload.response.failure_list.length
        ? payload.response.failure_list
        : normalizedItemIds.map((itemId) => ({
            item_id: Number(itemId),
            failed_reason:
              payload?.message ||
              payload?.warning ||
              error?.message ||
              "Falha ao impulsionar item.",
          }));

    const batch = await createProductBoostBatch({
      shopId: shop.id,
      userId,
      requestedItemIds: normalizedItemIds,
      requestId: payload?.request_id || null,
      warning: payload?.warning || null,
      successItemIds: [],
      failureList,
    });
    clearOverviewCacheForShop(shop.id);

    const [currentRaw, lastSuccessfulItemIds] = await Promise.all([
      getSafeCurrentBoostedItems(shop, { forceRemote: true }),
      listLatestSuccessfulBoostItemIds(shop.id),
    ]);
    const slotLimitReached = isSlotLimitReached({ payload, failureList });
    const current = { ...(currentRaw || {}) };
    if (slotLimitReached) {
      current.slotsLimit = 5;
      current.slotsUsed = Math.max(5, Number(current?.slotsUsed || 0));
      current.slotsAvailable = 0;
      current.nextSlotInSeconds = Math.max(
        60,
        Number(current?.nextSlotInSeconds || 0),
      );
      current.maxCooldownInSeconds = Math.max(
        Number(current?.maxCooldownInSeconds || 0),
        Number(current?.nextSlotInSeconds || 0),
      );
    }

    return {
      ok: false,
      batch,
      result: payload || null,
      current,
      lastSuccessfulItemIds,
      message: payload?.message || error?.message || "Falha ao impulsionar itens.",
      slotLimitReached,
      nextSlotInSeconds: Number(current?.nextSlotInSeconds || 0),
    };
  }
}

module.exports = {
  getOverview,
  runBoost,
};
