"use strict";

const ShopeeAdsService = require("./ShopeeAdsService");
const {
  aggregateAdsMetricsByShopAndRange,
  sumStorePaidRevenueCents,
} = require("../repositories/analyticsSqlRepository");
const { callAdsWithAutoRefresh } = require("./ShopeeAdsTokenService");

function toShopeeDate(iso) {
  const [year, month, day] = String(iso || "").split("-");
  if (!year || !month || !day) return null;
  return `${day}-${month}-${year}`;
}

function moneyToCents(value) {
  if (value == null || value === "") return 0;
  const normalized = typeof value === "string" && value.includes(",")
    ? value.replace(/\./g, "").replace(",", ".")
    : value;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function pickPreferredMetric(preferredValue, fallbackValue) {
  const preferred = Number(preferredValue || 0);
  return preferred > 0 ? preferred : Number(fallbackValue || 0);
}

function hasAdsSignal(totals = {}) {
  return [
    totals.expenseCents,
    totals.broadGmvCents,
    totals.directGmvCents,
    totals.broadOrders,
    totals.directOrders,
    totals.broadItemsSold,
    totals.directItemsSold,
  ].some((value) => Number(value || 0) > 0);
}

function chunkIsoDateRange(from, to, maxDays = 30) {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return [];

  const chunks = [];
  let cursor = start;
  while (cursor <= end) {
    const chunkStart = new Date(cursor);
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maxDays - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({
      from: chunkStart.toISOString().slice(0, 10),
      to: chunkEnd.toISOString().slice(0, 10),
    });
    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return chunks;
}

async function fetchOfficialDailyAdsTotalsWithDependencies({
  shop,
  dateFrom,
  dateTo,
  dependencies = {},
}) {
  const deps = {
    callAdsWithAutoRefresh,
    getDailyPerformance: ShopeeAdsService.get_all_cpc_ads_daily_performance,
    ...dependencies,
  };
  const ranges = chunkIsoDateRange(dateFrom, dateTo);
  if (!ranges.length) return { available: false, rows: 0 };

  const rows = [];
  for (const range of ranges) {
    const raw = await deps.callAdsWithAutoRefresh({
      shop,
      call: (accessToken) => deps.getDailyPerformance({
        accessToken,
        shopId: shop.shopId,
        startDate: toShopeeDate(range.from),
        endDate: toShopeeDate(range.to),
      }),
    });
    if (Array.isArray(raw?.response)) rows.push(...raw.response);
  }

  const totals = rows.reduce((acc, row) => {
    acc.expenseCents += moneyToCents(row?.expense);
    acc.broadGmvCents += moneyToCents(row?.broad_gmv);
    acc.directGmvCents += moneyToCents(row?.direct_gmv);
    acc.broadOrders += Number(row?.broad_order || 0);
    acc.directOrders += Number(row?.direct_order || 0);
    acc.broadItemsSold += Number(row?.broad_item_sold || 0);
    acc.directItemsSold += Number(row?.direct_item_sold || 0);
    return acc;
  }, {
    expenseCents: 0, broadGmvCents: 0, directGmvCents: 0,
    broadOrders: 0, directOrders: 0, broadItemsSold: 0, directItemsSold: 0,
  });
  return { available: rows.length > 0 && hasAdsSignal(totals), rows: rows.length, ...totals };
}

async function fetchOfficialDailyAdsTotals(input) {
  return fetchOfficialDailyAdsTotalsWithDependencies(input);
}

async function collectRoasMetricsForRangeWithDependencies({
  shop, shopDbId, start, end, dateFrom, dateTo, dependencies = {},
}) {
  const deps = {
    aggregateAdsMetricsByShopAndRange,
    sumStorePaidRevenueCents,
    fetchOfficialDailyAdsTotals,
    ...dependencies,
  };
  const localFallback = (name, fallback, operation) => operation().catch((error) => {
    console.warn("[AdsRoasMetricsService] local metric unavailable", {
      shopId: shopDbId,
      name,
      message: error?.message,
      code: error?.code,
    });
    return fallback;
  });
  const [dbAdsAgg, storeGmvCents, officialTotalsResult] = await Promise.all([
    localFallback("ads_hourly", { _sum: {} }, () => deps.aggregateAdsMetricsByShopAndRange(shopDbId, start, end, "CPC")),
    localFallback("paid_revenue", 0, () => deps.sumStorePaidRevenueCents(shopDbId, start, end)),
    deps.fetchOfficialDailyAdsTotals({ shop, dateFrom, dateTo }).catch((error) => {
      console.warn("[AdsRoasMetricsService] official totals unavailable", {
        shopId: shopDbId, message: error?.message, code: error?.code, dateFrom, dateTo,
      });
      return null;
    }),
  ]);
  const dbSpendCents = Number(dbAdsAgg?._sum?.expense || 0);
  const dbBroadGmvCents = Number(dbAdsAgg?._sum?.broadGmv || 0);
  const dbDirectGmvCents = Number(dbAdsAgg?._sum?.directGmv || 0);
  const snapshotTotals = {
    expenseCents: dbSpendCents,
    broadGmvCents: dbBroadGmvCents,
    directGmvCents: dbDirectGmvCents,
    broadOrders: Number(dbAdsAgg?._sum?.broadSold || 0),
    directOrders: Number(dbAdsAgg?._sum?.directSold || 0),
    broadItemsSold: Number(dbAdsAgg?._sum?.broadSold || 0),
    directItemsSold: Number(dbAdsAgg?._sum?.directSold || 0),
  };
  const snapshotAvailable = hasAdsSignal(snapshotTotals);
  const officialAvailable = Boolean(
    officialTotalsResult?.available && hasAdsSignal(officialTotalsResult),
  );
  const adsTotals = officialAvailable ? officialTotalsResult : snapshotAvailable ? snapshotTotals : {};
  const spendCents = Number(adsTotals.expenseCents || 0);
  const attributedGmvCents = pickPreferredMetric(adsTotals.broadGmvCents, adsTotals.directGmvCents);
  const ordersMatched = pickPreferredMetric(adsTotals.broadOrders, adsTotals.directOrders);
  const itemsSold = pickPreferredMetric(adsTotals.broadItemsSold, adsTotals.directItemsSold);
  const roas = spendCents > 0 ? attributedGmvCents / spendCents : null;
  const tacosPct = Number(storeGmvCents || 0) > 0 ? (spendCents / Number(storeGmvCents)) * 100 : null;
  const adsRevenueSharePct = Number(storeGmvCents || 0) > 0 ? (attributedGmvCents / Number(storeGmvCents)) * 100 : null;

  return {
    sourceAdsTotals: officialAvailable
      ? "official_daily_performance"
      : snapshotAvailable
        ? "database_snapshot"
        : "database_fallback",
    metrics: {
      spendCents,
      attributedGmvCents,
      storeGmvCents: Number(storeGmvCents || 0),
      roas: roas == null ? null : Number(roas.toFixed(4)),
      tacosPct: tacosPct == null ? null : Number(tacosPct.toFixed(2)),
      adsRevenueSharePct: adsRevenueSharePct == null ? null : Number(adsRevenueSharePct.toFixed(2)),
    },
    counts: { ordersMatched, itemsSold },
  };
}

async function collectRoasMetricsForRange(input) {
  return collectRoasMetricsForRangeWithDependencies(input);
}

module.exports = {
  chunkIsoDateRange,
  collectRoasMetricsForRange,
  _test: {
    chunkIsoDateRange,
    fetchOfficialDailyAdsTotalsWithDependencies,
    collectRoasMetricsForRangeWithDependencies,
  },
};
