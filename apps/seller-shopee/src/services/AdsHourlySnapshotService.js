const {
  upsertAdsHourlyMetric,
} = require("../repositories/adsSqlRepository");
const ShopeeAdsService = require("./ShopeeAdsService");
const {
  callAdsWithAutoRefresh,
  listConnectedAdsShops,
} = require("./ShopeeAdsTokenService");

const DEFAULT_TZ_OFFSET = process.env.SHOPEE_REPORT_TZ_OFFSET || "-03:00";

function moneyToCents(value) {
  if (value == null) return 0;
  const parsed =
    typeof value === "string" ? Number(value.replace(",", ".")) : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toShopeeDateFromIso(iso) {
  const [year, month, day] = String(iso || "").split("-");
  if (!year || !month || !day) return null;
  return `${day}-${month}-${year}`;
}

function isoTodayUTC() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(
    now.getUTCDate(),
  ).padStart(2, "0")}`;
}

function shopeeDateToMetricDate(dateDDMMYYYY, tzOffset = DEFAULT_TZ_OFFSET) {
  const [day, month, year] = String(dateDDMMYYYY || "").split("-");
  if (!day || !month || !year) return null;
  return new Date(`${year}-${month}-${day}T00:00:00.000${tzOffset}`);
}

const AdsHourlySnapshotService = {
  async run() {
    const shops = await listConnectedAdsShops();

    let processedShops = 0;
    let upserts = 0;

    const todayIso = isoTodayUTC();
    const todayPerf = toShopeeDateFromIso(todayIso);
    const now = new Date();
    const includeYesterday = now.getUTCHours() <= 2;
    const datesToFetch = [todayPerf].filter(Boolean);

    if (includeYesterday) {
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const yesterdayIso = `${yesterday.getUTCFullYear()}-${String(
        yesterday.getUTCMonth() + 1,
      ).padStart(2, "0")}-${String(yesterday.getUTCDate()).padStart(2, "0")}`;
      const yesterdayPerf = toShopeeDateFromIso(yesterdayIso);
      if (yesterdayPerf) {
        datesToFetch.push(yesterdayPerf);
      }
    }

    for (const shop of shops) {
      processedShops += 1;

      for (const performanceDate of datesToFetch) {
        const raw = await callAdsWithAutoRefresh({
          shop,
          call: (accessToken) =>
            ShopeeAdsService.get_all_cpc_ads_hourly_performance({
              accessToken,
              shopId: shop.shopId,
              performanceDate,
            }),
        });

        const rows = Array.isArray(raw?.response) ? raw.response : [];
        if (!rows.length) {
          continue;
        }

        for (const row of rows) {
          const metricDate = shopeeDateToMetricDate(row.date);
          const hour = numberOrZero(row.hour);
          if (!metricDate || hour < 0 || hour > 23) {
            continue;
          }

          await upsertAdsHourlyMetric({
            shopId: shop.id,
            date: metricDate,
            hour,
            type: "CPC",
            itemId: row.item_id || row.itemId || null,
            impression: numberOrZero(row.impression),
            click: numberOrZero(row.click),
            ctr: numberOrZero(row.ctr),
            expense: moneyToCents(row.expense),
            cpc: moneyToCents(row.cpc),
            directGmv: moneyToCents(row.direct_gmv),
            directSold: numberOrZero(row.direct_order ?? row.direct_sold),
            directRoas: numberOrZero(row.direct_roas),
            broadGmv: moneyToCents(row.broad_gmv),
            broadSold: numberOrZero(row.broad_order ?? row.broad_sold),
            broadRoas: numberOrZero(row.broad_roas),
          });

          upserts += 1;
        }
      }
    }

    return { ok: true, processedShops, upserts };
  },
};

module.exports = AdsHourlySnapshotService;
