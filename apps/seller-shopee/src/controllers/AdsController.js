const ShopeeAdsService = require("../services/ShopeeAdsService");
const {
  chunkIsoDateRange,
  collectRoasMetricsForRange,
} = require("../services/AdsRoasMetricsService");
const { resolveShop } = require("../utils/resolveShop");
const { hourIndexInOffset } = require("../utils/timezone");
const { buildMonthlyAdsCostIndex } = require("../utils/monthlyAdsCost");
const {
  aggregateAdsMetricsByShopAndRange,
  aggregateAttributedOrderItemsByShopAndRange,
  aggregateAttributedOrdersByShopAndRange,
  listAdsMetricsGroupedByItemId,
  listProductsByShopAndItemIds,
  sumStorePaidRevenueCents,
} = require("../repositories/analyticsSqlRepository");
const {
  callAdsWithAutoRefresh,
  getShopAdsAccessToken,
  getShopeeErrData,
  isInvalidAccessToken,
} = require("../services/ShopeeAdsTokenService");
const {
  getAutomationConfigByShopId,
  upsertAutomationConfig,
} = require("../repositories/adsIntelligenceAutomationSqlRepository");

function toShopeeDate(iso) {
  const [y, m, d] = String(iso || "").split("-");
  if (!y || !m || !d) return null;
  return `${d}-${m}-${y}`;
}

function moneyToCents(value) {
  if (value == null || value === "") return 0;
  const normalized =
    typeof value === "string"
      ? value.includes(",")
        ? value.replace(/\./g, "").replace(",", ".")
        : value
      : value;
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

function isoDayFromShopee(ddmmyyyy) {
  const [d, m, y] = String(ddmmyyyy || "").split("-");
  if (!y || !m || !d) return null;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function extractCampaignIdList(raw) {
  const response = raw?.response;
  const fromCampaignList = Array.isArray(response?.campaign_list)
    ? response.campaign_list
    : [];
  const fromResponseArray = Array.isArray(response)
    ? response.map((entry) =>
        entry && typeof entry === "object" ? entry : { campaign_id: entry },
      )
    : [];
  const fromCampaignIdList = Array.isArray(response?.campaign_id_list)
    ? response.campaign_id_list.map((entry) => ({ campaign_id: entry }))
    : [];

  return [...fromCampaignList, ...fromResponseArray, ...fromCampaignIdList]
    .map((entry) => {
      const campaignId =
        entry && typeof entry === "object" ? entry.campaign_id : entry;
      if (campaignId == null || String(campaignId).trim() === "") return null;
      return {
        ...(entry && typeof entry === "object" ? entry : {}),
        campaign_id: String(campaignId),
      };
    })
    .filter(Boolean);
}

async function fetchProductLevelCampaignIdPages({
  shop,
  adType = "",
  limit = 100,
  maxPages = 100,
}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 100));
  const byId = new Map();
  let lastRaw = null;
  let offset = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const raw = await callAdsWithAutoRefresh({
      shop,
      call: (nextAccessToken) =>
        ShopeeAdsService.get_product_level_campaign_id_list({
          accessToken: nextAccessToken,
          shopId: shop.shopId,
          adType,
          offset,
          limit: safeLimit,
        }),
    });

    lastRaw = raw;
    const list = extractCampaignIdList(raw);
    for (const item of list) byId.set(String(item.campaign_id), item);

    const hasMore =
      raw?.response?.more === true ||
      raw?.response?.has_next_page === true ||
      raw?.response?.has_next === true;
    if (!hasMore && list.length < safeLimit) break;
    if (!list.length) break;
    offset += list.length;
  }

  return {
    raw: lastRaw || {},
    campaignList: Array.from(byId.values()),
  };
}

function sendAdsConnectionError(res, error) {
  if (error?.code !== "ads_not_connected") return false;
  res.status(error?.statusCode || 400).json({
    error: {
      code: error.code,
      message: error.message,
    },
  });
  return true;
}

async function fetchOfficialDailyAdsTotals({ shop, dateFrom, dateTo }) {
  const startDate = toShopeeDate(dateFrom);
  const endDate = toShopeeDate(dateTo);
  if (!startDate || !endDate) {
    return {
      available: false,
      expenseCents: 0,
      broadGmvCents: 0,
      directGmvCents: 0,
      broadOrders: 0,
      directOrders: 0,
      broadItemsSold: 0,
      directItemsSold: 0,
    };
  }

  const raw = await callAdsWithAutoRefresh({
    shop,
    call: (accessToken) =>
      ShopeeAdsService.get_all_cpc_ads_daily_performance({
        accessToken,
        shopId: shop.shopId,
        startDate,
        endDate,
      }),
  });

  const rows = Array.isArray(raw?.response) ? raw.response : [];
  const totals = rows.reduce(
    (acc, row) => {
      acc.expenseCents += moneyToCents(row?.expense);
      acc.broadGmvCents += moneyToCents(row?.broad_gmv);
      acc.directGmvCents += moneyToCents(row?.direct_gmv);
      acc.broadOrders += Number(row?.broad_order || 0);
      acc.directOrders += Number(row?.direct_order || 0);
      acc.broadItemsSold += Number(row?.broad_item_sold || 0);
      acc.directItemsSold += Number(row?.direct_item_sold || 0);
      return acc;
    },
    {
      expenseCents: 0,
      broadGmvCents: 0,
      directGmvCents: 0,
      broadOrders: 0,
      directOrders: 0,
      broadItemsSold: 0,
      directItemsSold: 0,
    },
  );

  return {
    available: true,
    rows: rows.length,
    ...totals,
  };
}

function pickPreferredMetric(preferredValue, fallbackValue) {
  const preferred = Number(preferredValue || 0);
  if (preferred > 0) return preferred;
  return Number(fallbackValue || 0);
}

function toFiniteMetricNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickMetricField(source, keys = []) {
  if (!source || typeof source !== "object") return null;
  for (const key of keys) {
    const value = toFiniteMetricNumber(source?.[key]);
    if (value != null) return value;
  }
  return null;
}

async function getStorePaidRevenueCents({ shopId, start, end }) {
  return sumStorePaidRevenueCents(shopId, start, end);
}

function shiftIsoMonthClamped(isoDate, monthDelta) {
  const [yearRaw, monthRaw, dayRaw] = String(isoDate || "").split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  const sourceMonthIndex = month - 1;
  const targetMonthIndex = sourceMonthIndex + Number(monthDelta || 0);
  const targetYear =
    year + Math.floor(targetMonthIndex / 12);
  const normalizedTargetMonthIndex =
    ((targetMonthIndex % 12) + 12) % 12;

  const maxTargetDay = new Date(
    Date.UTC(targetYear, normalizedTargetMonthIndex + 1, 0),
  ).getUTCDate();
  const targetDay = Math.min(day, maxTargetDay);

  return `${String(targetYear).padStart(4, "0")}-${String(
    normalizedTargetMonthIndex + 1,
  ).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

function pctDelta(currentValue, previousValue) {
  const current = Number(currentValue || 0);
  const previous = Number(previousValue || 0);

  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return Number((((current - previous) / previous) * 100).toFixed(2));
}

async function collectRoasMetricsForRangeLegacy({
  shop,
  shopDbId,
  start,
  end,
  dateFrom,
  dateTo,
}) {
  const [dbAdsAgg, attrAgg, itemsAgg, storeGmvCents, officialTotalsResult] =
    await Promise.all([
      aggregateAdsMetricsByShopAndRange(shopDbId, start, end, "CPC"),
      aggregateAttributedOrdersByShopAndRange(shopDbId, start, end, "CPC"),
      aggregateAttributedOrderItemsByShopAndRange(shopDbId, start, end, "CPC"),
      getStorePaidRevenueCents({ shopId: shopDbId, start, end }),
      fetchOfficialDailyAdsTotals({ shop, dateFrom, dateTo }).catch((error) => {
        console.warn("[AdsController.roasRealApprox] official totals unavailable", {
          shopId: shopDbId,
          message: error?.message,
          code: error?.code,
          dateFrom,
          dateTo,
        });
        return null;
      }),
    ]);

  const dbSpendCents = Number(dbAdsAgg?._sum?.expense || 0);
  const dbAttributedBroadGmvCents = Number(dbAdsAgg?._sum?.broadGmv || 0);
  const dbAttributedDirectGmvCents = Number(dbAdsAgg?._sum?.directGmv || 0);
  const dbItemsSold = pickPreferredMetric(
    dbAdsAgg?._sum?.broadSold,
    dbAdsAgg?._sum?.directSold,
  );

  const localAttributedGmvCents = Number(attrAgg?._sum?.gmvCents || 0);
  const localOrdersMatched = Number(attrAgg?._count?.id || 0);
  const localItemsSold = Number(itemsAgg?._sum?.quantity || 0);

  const officialAvailable = Boolean(officialTotalsResult?.available);
  const spendCents = officialAvailable
    ? Number(officialTotalsResult.expenseCents || 0)
    : dbSpendCents;
  const attributedGmvCents = officialAvailable
    ? pickPreferredMetric(
        officialTotalsResult.broadGmvCents,
        officialTotalsResult.directGmvCents,
      )
    : pickPreferredMetric(
        dbAttributedBroadGmvCents,
        dbAttributedDirectGmvCents || localAttributedGmvCents,
      );
  const ordersMatched = officialAvailable
    ? pickPreferredMetric(
        officialTotalsResult.broadOrders,
        officialTotalsResult.directOrders,
      )
    : localOrdersMatched;
  const itemsSold = officialAvailable
    ? pickPreferredMetric(
        officialTotalsResult.broadItemsSold,
        officialTotalsResult.directItemsSold,
      )
    : pickPreferredMetric(dbItemsSold, localItemsSold);

  const roas = spendCents > 0 ? attributedGmvCents / spendCents : null;
  const tacosPct =
    storeGmvCents > 0 ? (spendCents / storeGmvCents) * 100 : null;
  const adsRevenueSharePct =
    storeGmvCents > 0 ? (attributedGmvCents / storeGmvCents) * 100 : null;

  return {
    sourceAdsTotals: officialAvailable
      ? "official_daily_performance"
      : "database_fallback",
    metrics: {
      spendCents,
      attributedGmvCents,
      storeGmvCents,
      roas: roas == null ? null : Number(roas.toFixed(4)),
      tacosPct: tacosPct == null ? null : Number(tacosPct.toFixed(2)),
      adsRevenueSharePct:
        adsRevenueSharePct == null ? null : Number(adsRevenueSharePct.toFixed(2)),
    },
    counts: { ordersMatched, itemsSold },
  };
}

async function balance(req, res, next) {
  try {
    const shop = await resolveShop(req, req.params.shopId);

    const raw = await callAdsWithAutoRefresh({
      shop,
      call: (accessToken) =>
        ShopeeAdsService.get_total_balance({
          accessToken,
          shopId: shop.shopId,
        }),
    });

    return res.json(raw);
  } catch (e) {
    if (sendAdsConnectionError(res, e)) return;

    const data = getShopeeErrData(e);
    if (isInvalidAccessToken(e)) {
      return res.status(401).json({
        error: {
          message: "Token Shopee inválido/expirado. Refaça a conexão da loja.",
          details: data,
        },
      });
    }
    const status = e?.response?.status || e?.statusCode || 500;
    const details = getShopeeErrData(e);

    if (status === 401 || status === 403) {
      return res.status(status).json({
        error: {
          message:
            "Shopee recusou o token de Ads. Refaça a conexão da loja (ou aguarde refresh).",
          details,
        },
      });
    }

    if (e?.statusCode) {
      return res.status(e.statusCode).json({
        error: {
          code: e.code,
          message: e.message,
        },
      });
    }

    return next(e);
  }
}

async function dailyPerformance(req, res, next) {
  try {
    const shop = await resolveShop(req, req.params.shopId);
    const accessToken = await getShopAdsAccessToken(shop.id);
    if (!accessToken) {
      return res.status(400).json({
        error: {
          code: "ads_not_connected",
          message:
            "Ads nao conectado para esta loja. Clique em Integrar Ads para autorizar o app de Ads.",
        },
      });
    }

    const { dateFrom, dateTo } = req.query;
    const dateRanges = chunkIsoDateRange(dateFrom, dateTo);
    if (!dateRanges.length) {
      return res.status(400).json({
        error: { message: "dateFrom/dateTo inválidos. Use YYYY-MM-DD." },
      });
    }

    const rawParts = [];
    const rows = [];
    for (const dateRange of dateRanges) {
      const raw = await callAdsWithAutoRefresh({
        shop,
        call: (accessToken) =>
          ShopeeAdsService.get_all_cpc_ads_daily_performance({
            accessToken,
            shopId: shop.shopId,
            startDate: toShopeeDate(dateRange.from),
            endDate: toShopeeDate(dateRange.to),
          }),
      });
      rawParts.push(raw);
      if (Array.isArray(raw?.response)) rows.push(...raw.response);
    }
    const firstRaw = rawParts[0] || {};
    const series = rows.map((r) => ({
      date: isoDayFromShopee(r.date),
      impression: r.impression ?? 0,
      clicks: r.clicks ?? 0,
      expense: r.expense ?? 0,
      direct_gmv: r.direct_gmv ?? 0,
      broad_gmv: r.broad_gmv ?? 0,
      direct_order: r.direct_order ?? 0,
      broad_order: r.broad_order ?? 0,
      direct_item_sold: r.direct_item_sold ?? 0,
      broad_item_sold: r.broad_item_sold ?? 0,
      ctr: r.ctr ?? 0,
      direct_roas: r.direct_roas ?? 0,
      broad_roas: r.broad_roas ?? 0,
    }));

    const totals = series.reduce(
      (acc, x) => {
        acc.impression += Number(x.impression || 0);
        acc.clicks += Number(x.clicks || 0);
        acc.expense += Number(x.expense || 0);
        acc.direct_gmv += Number(x.direct_gmv || 0);
        acc.broad_gmv += Number(x.broad_gmv || 0);
        acc.direct_order += Number(x.direct_order || 0);
        acc.broad_order += Number(x.broad_order || 0);
        acc.direct_item_sold += Number(x.direct_item_sold || 0);
        acc.broad_item_sold += Number(x.broad_item_sold || 0);
        return acc;
      },
      {
        impression: 0,
        clicks: 0,
        expense: 0,
        direct_gmv: 0,
        broad_gmv: 0,
        direct_order: 0,
        broad_order: 0,
        direct_item_sold: 0,
        broad_item_sold: 0,
      },
    );

    res.json({
      request_id: firstRaw.request_id,
      warning: firstRaw.warning,
      error: firstRaw.error || "",
      message: firstRaw.message,
      response: { series, totals },
    });
  } catch (e) {
    if (sendAdsConnectionError(res, e)) return;
    next(e);
  }
}

async function listCampaignIds(req, res, next) {
  try {
    const shop = await resolveShop(req, req.params.shopId);
    const accessToken = await getShopAdsAccessToken(shop.id);
    if (!accessToken) {
      return res.status(400).json({
        error: {
          code: "ads_not_connected",
          message:
            "Ads nao conectado para esta loja. Clique em Integrar Ads para autorizar o app de Ads.",
        },
      });
    }

    const adType = String(req.query.adType ?? ""); // "" = todos
    const hasManualPaging =
      req.query.offset != null || req.query.limit != null;

    if (!hasManualPaging) {
      const { raw, campaignList } = await fetchProductLevelCampaignIdPages({
        shop,
        adType,
      });

      return res.json({
        ...raw,
        response: {
          ...(raw?.response && !Array.isArray(raw.response)
            ? raw.response
            : {}),
          campaign_list: campaignList,
          campaign_id_list: campaignList.map((item) => item.campaign_id),
          total: campaignList.length,
        },
      });
    }

    const raw = await callAdsWithAutoRefresh({
      shop,
      call: (nextAccessToken) =>
        ShopeeAdsService.get_product_level_campaign_id_list({
          accessToken: nextAccessToken,
          shopId: shop.shopId,
          adType,
          offset: Number(req.query.offset || 0),
          limit: Math.max(1, Math.min(100, Number(req.query.limit || 100))),
        }),
    });

    res.json(raw);
  } catch (e) {
    next(e);
  }
}

function normalizeCampaignItemIds(campaignSettings) {
  const common = campaignSettings?.common_info || {};
  const declaredItems = Array.isArray(common.item_id_list) ? common.item_id_list : [];
  const automaticItems = Array.isArray(campaignSettings?.auto_product_ads_info)
    ? campaignSettings.auto_product_ads_info.map((entry) => entry?.item_id)
    : [];
  return Array.from(
    new Set(
      [...declaredItems, ...automaticItems]
        .filter((itemId) => itemId != null && String(itemId).trim() !== "")
        .map((itemId) => String(itemId)),
    ),
  );
}

async function groupedCampaigns(req, res, next) {
  try {
    const shop = await resolveShop(req, req.params.shopId);
    const accessToken = await getShopAdsAccessToken(shop.id);
    if (!accessToken) {
      return res.status(400).json({
        error: {
          code: "ads_not_connected",
          message: "Ads nao conectado para esta loja. Clique em Integrar Ads para autorizar o app de Ads.",
        },
      });
    }

    const adType = String(req.query.adType ?? "");
    const scope = String(req.query.scope ?? "multi").trim().toLowerCase();
    if (!new Set(["all", "multi", "single", "empty"]).has(scope)) {
      return res.status(400).json({
        error: { message: "scope invalido. Use all, multi, single ou empty." },
      });
    }

    const { raw: idsRaw, campaignList } = await fetchProductLevelCampaignIdPages({
      shop,
      adType,
    });
    const campaignIds = campaignList.map((campaign) => campaign.campaign_id).filter(Boolean);
    const settingsByCampaignId = new Map();

    for (const campaignIdBatch of chunk(campaignIds, 100)) {
      const raw = await callAdsWithAutoRefresh({
        shop,
        call: (nextAccessToken) =>
          ShopeeAdsService.get_product_level_campaign_setting_info({
            accessToken: nextAccessToken,
            shopId: shop.shopId,
            infoTypeList: [1, 2, 3, 4],
            campaignIdList: campaignIdBatch,
          }),
      });
      const settings = Array.isArray(raw?.response?.campaign_list)
        ? raw.response.campaign_list
        : [];
      for (const setting of settings) {
        if (setting?.campaign_id != null) {
          settingsByCampaignId.set(String(setting.campaign_id), setting);
        }
      }
    }

    const campaigns = campaignIds.map((campaignId) => {
      const settings = settingsByCampaignId.get(String(campaignId)) || {};
      const common = settings.common_info || {};
      const itemIds = normalizeCampaignItemIds(settings);
      const itemCount = itemIds.length;
      const classification = itemCount > 1
        ? "MULTI_ITEM"
        : itemCount === 1
          ? "SINGLE_ITEM"
          : "NO_ITEMS";

      return {
        campaign_id: String(campaignId),
        ad_name: common.ad_name || null,
        ad_type: common.ad_type || null,
        campaign_status: common.campaign_status || null,
        campaign_placement: common.campaign_placement || null,
        campaign_budget: common.campaign_budget ?? null,
        classification,
        is_multi_item: itemCount > 1,
        linked_item_count: itemCount,
        linked_item_ids: itemIds,
      };
    });

    const filteredCampaigns = campaigns.filter((campaign) => {
      if (scope === "all") return true;
      if (scope === "multi") return campaign.classification === "MULTI_ITEM";
      if (scope === "single") return campaign.classification === "SINGLE_ITEM";
      return campaign.classification === "NO_ITEMS";
    });

    return res.json({
      request_id: idsRaw?.request_id,
      warning: idsRaw?.warning,
      error: idsRaw?.error || "",
      response: {
        source: {
          campaigns: "get_product_level_campaign_id_list",
          settings: "get_product_level_campaign_setting_info",
        },
        total_campaigns: campaigns.length,
        total_multi_item_campaigns: campaigns.filter((campaign) => campaign.is_multi_item).length,
        campaigns: filteredCampaigns,
      },
    });
  } catch (error) {
    if (sendAdsConnectionError(res, error)) return;
    return next(error);
  }
}
async function campaignsDailyPerformance(req, res, next) {
  try {
    const shop = await resolveShop(req, req.params.shopId);
    const accessToken = await getShopAdsAccessToken(shop.id);
    if (!accessToken) {
      return res.status(400).json({
        error: {
          code: "ads_not_connected",
          message:
            "Ads nao conectado para esta loja. Clique em Integrar Ads para autorizar o app de Ads.",
        },
      });
    }

    const { dateFrom, dateTo } = req.query;
    const dateRanges = chunkIsoDateRange(dateFrom, dateTo);
    if (!dateRanges.length) {
      return res.status(400).json({
        error: { message: "dateFrom/dateTo inválidos. Use YYYY-MM-DD." },
      });
    }

    const adType = String(req.query.adType ?? ""); // "" = todos

    // 1) pega todos os campaign ids
    const { raw: idsResp, campaignList } = await fetchProductLevelCampaignIdPages({
      shop,
      adType,
    });

    const campaignIds = campaignList.map((c) => c.campaign_id).filter(Boolean);

    if (!campaignIds.length) {
      return res.json({
        request_id: idsResp?.request_id,
        error: "",
        response: {
          campaigns: [],
          seriesByCampaignId: {},
        },
      });
    }

    // 2) busca performance em lotes (max 100)
    const batches = chunk(campaignIds, 100);
    const rawParts = [];

    for (const dateRange of dateRanges) {
      for (const batch of batches) {
        const part = await callAdsWithAutoRefresh({
          shop,
          call: (nextAccessToken) =>
            ShopeeAdsService.get_product_campaign_daily_performance({
              accessToken: nextAccessToken,
              shopId: shop.shopId,
              startDate: toShopeeDate(dateRange.from),
              endDate: toShopeeDate(dateRange.to),
              campaignIdList: batch,
            }),
        });
        rawParts.push(part);
      }
    }

    // 3) normaliza: uma linha por campanha, e série diária por campanha
    const campaignsById = new Map();
    const seriesByCampaignId = {}; // { [campaignId]: [{date,...metrics}] }

    for (const raw of rawParts) {
      const resp = raw?.response;

      // ✅ Aceita response como array OU objeto
      const blocks = Array.isArray(resp) ? resp : resp ? [resp] : [];

      for (const shopBlock of blocks) {
        const cl = Array.isArray(shopBlock?.campaign_list)
          ? shopBlock.campaign_list
          : [];

        for (const c of cl) {
          const campaignId = String(c.campaign_id);
          const adType = c.ad_type || null;
          const placement = c.campaign_placement || null;
          const name = c.ad_name || null;

          const metricsList = Array.isArray(c.metrics_list)
            ? c.metrics_list
            : [];
          const series = metricsList.map((m) => ({
            date: isoDayFromShopee(m.date),
            impression: m.impression ?? 0,
            clicks: m.clicks ?? 0,
            expense: m.expense ?? 0,
            direct_gmv: m.direct_gmv ?? 0,
            broad_gmv: m.broad_gmv ?? 0,
            direct_order: m.direct_order ?? 0,
            broad_order: m.broad_order ?? 0,
            direct_roi: m.direct_roi ?? 0,
            broad_roi: m.broad_roi ?? 0,
            direct_cir: m.direct_cir ?? 0,
            broad_cir: m.broad_cir ?? 0,
            direct_cr: m.direct_cr ?? 0,
            cr: m.cr ?? 0,
            cpc: m.cpc ?? 0,
          }));

          seriesByCampaignId[campaignId] = (
            seriesByCampaignId[campaignId] || []
          ).concat(series);

          const totals = series.reduce(
            (acc, x) => {
              acc.impression += Number(x.impression || 0);
              acc.clicks += Number(x.clicks || 0);
              acc.expense += Number(x.expense || 0);
              acc.direct_gmv += Number(x.direct_gmv || 0);
              acc.broad_gmv += Number(x.broad_gmv || 0);
              acc.direct_order += Number(x.direct_order || 0);
              acc.broad_order += Number(x.broad_order || 0);
              return acc;
            },
            {
              impression: 0,
              clicks: 0,
              expense: 0,
              direct_gmv: 0,
              broad_gmv: 0,
              direct_order: 0,
              broad_order: 0,
            },
          );

          const current = campaignsById.get(campaignId) || {
            campaign_id: campaignId,
            ad_type: adType,
            campaign_placement: placement,
            ad_name: name,
            metrics: {
              impression: 0,
              clicks: 0,
              expense: 0,
              direct_gmv: 0,
              broad_gmv: 0,
              direct_order: 0,
              broad_order: 0,
            },
          };
          current.ad_type ||= adType;
          current.campaign_placement ||= placement;
          current.ad_name ||= name;
          for (const key of Object.keys(current.metrics)) {
            current.metrics[key] += Number(totals[key] || 0);
          }
          campaignsById.set(campaignId, current);
        }
      }
    }

    res.json({
      request_id: rawParts?.[0]?.request_id,
      warning: rawParts?.[0]?.warning,
      error: rawParts?.[0]?.error || "",
      response: {
        campaigns: Array.from(campaignsById.values()),
        seriesByCampaignId,
      },
    });
  } catch (e) {
    next(e);
  }
}

async function campaignSettings(req, res, next) {
  try {
    const shop = await resolveShop(req, req.params.shopId);
    const accessToken = await getShopAdsAccessToken(shop.id);
    if (!accessToken) {
      return res.status(400).json({
        error: {
          code: "ads_not_connected",
          message:
            "Ads nao conectado para esta loja. Clique em Integrar Ads para autorizar o app de Ads.",
        },
      });
    }

    const campaignIdsRaw = String(req.query.campaignIds || "").trim();
    if (!campaignIdsRaw) {
      return res
        .status(400)
        .json({ error: { message: "campaignIds é obrigatório (csv)." } });
    }

    const campaignIdList = campaignIdsRaw
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    if (campaignIdList.length > 100) {
      return res
        .status(400)
        .json({ error: { message: "Máximo 100 campaignIds por chamada." } });
    }

    const infoTypesRaw = String(req.query.infoTypes || "1,2,3,4");
    const infoTypeList = infoTypesRaw
      .split(",")
      .map((x) => Number(x.trim()))
      .filter((x) => Number.isFinite(x));

    if (!infoTypeList.length) {
      return res
        .status(400)
        .json({ error: { message: "infoTypes inválido." } });
    }

    const raw = await callAdsWithAutoRefresh({
      shop,
      call: (nextAccessToken) =>
        ShopeeAdsService.get_product_level_campaign_setting_info({
          accessToken: nextAccessToken,
          shopId: shop.shopId,
          infoTypeList,
          campaignIdList,
        }),
    });

    // Normalização leve: ids como string, timestamps -> ISO (se quiser)
    const campaigns = (raw?.response?.campaign_list || []).map((c) => {
      const common = c.common_info || {};
      const duration = common.campaign_duration || {};

      return {
        campaign_id: String(c.campaign_id),
        common_info: {
          ad_type: common.ad_type || null,
          ad_name: common.ad_name || null,
          campaign_status: common.campaign_status || null,
          bidding_method: common.bidding_method || null,
          campaign_placement: common.campaign_placement || null,
          campaign_budget: common.campaign_budget ?? null,
          campaign_duration: {
            start_time: duration.start_time ?? null,
            end_time: duration.end_time ?? null,
          },
          item_id_list: Array.isArray(common.item_id_list)
            ? common.item_id_list.map((id) => String(id))
            : [],
        },
        manual_bidding_info: c.manual_bidding_info || null,
        auto_bidding_info: c.auto_bidding_info || null,
        auto_product_ads_info: Array.isArray(c.auto_product_ads_info)
          ? c.auto_product_ads_info.map((p) => ({
              product_name: p.product_name || null,
              status: p.status || null,
              item_id: p.item_id != null ? String(p.item_id) : null,
            }))
          : [],
      };
    });

    // Enrichment: traz title + 1 imagem do seu DB para os item_ids retornados pelo settings
    const allItemIds = new Set();
    for (const c of campaigns) {
      const ids = Array.isArray(c?.common_info?.item_id_list)
        ? c.common_info.item_id_list
        : [];
      for (const id of ids) {
        if (id != null && String(id).trim() !== "") allItemIds.add(String(id));
      }
    }

    const products = allItemIds.size
      ? await listProductsByShopAndItemIds(shop.id, Array.from(allItemIds))
      : [];
          // ignora ids inválidos

    const productByItemId = new Map(
      products.map((p) => [
        String(p.itemId),
        { title: p.title || null, image_url: p.images?.[0]?.url || null },
      ]),
    );

    // Agora anexa linked_items em cada campanha
    const campaignsEnriched = campaigns.map((c) => {
      const itemIds = Array.isArray(c?.common_info?.item_id_list)
        ? c.common_info.item_id_list
        : [];

      // Para campanhas auto, temos auto_product_ads_info com status e nome
      const autoInfo = Array.isArray(c?.auto_product_ads_info)
        ? c.auto_product_ads_info
        : [];
      const autoMap = new Map(
        autoInfo.filter((x) => x?.item_id).map((x) => [String(x.item_id), x]),
      );

      const linked_items = itemIds.map((itemId) => {
        const key = String(itemId);
        const p = productByItemId.get(key) || {};
        const ai = autoMap.get(key) || {};
        return {
          item_id: key,
          title: p.title || null,
          image_url: p.image_url || null,
          product_name: ai.product_name || null,
          status: ai.status || null,
        };
      });

      return { ...c, linked_items };
    });

    res.json({
      request_id: raw?.request_id,
      warning: raw?.warning,
      error: raw?.error || "",
      message: raw?.message,
      response: {
        shop_id: raw?.response?.shop_id,
        region: raw?.response?.region,
        campaign_list: campaignsEnriched,
      },
    });
  } catch (e) {
    next(e);
  }
}

async function campaignItemsPerformance(req, res, next) {
  try {
    const shop = await resolveShop(req, req.params.shopId);

    const { campaignId, dateFrom, dateTo } = req.body || {};
    if (!campaignId || String(campaignId).trim() === "") {
      return res
        .status(400)
        .json({ error: { message: "campaignId é obrigatório." } });
    }

    // Valida datas (mesmo que o endpoint Shopee de item-performance use outro formato)
    if (!dateFrom || !dateTo) {
      return res.status(400).json({
        error: { message: "dateFrom/dateTo são obrigatórios (YYYY-MM-DD)." },
      });
    }
    const startDate = toShopeeDate(dateFrom);
    const endDate = toShopeeDate(dateTo);
    if (!startDate || !endDate) {
      return res.status(400).json({
        error: { message: "dateFrom/dateTo inválidos. Use YYYY-MM-DD." },
      });
    }

    const rangeStart = new Date(`${dateFrom}T00:00:00.000Z`);
    const rangeEnd = new Date(`${dateTo}T23:59:59.999Z`);

    // 1) Puxa settings para obter item_id_list e status/nome no ads
    const [rawSettings, monthlyAdsCost, itemMetricRows] = await Promise.all([
      callAdsWithAutoRefresh({
        shop,
        call: (accessToken) =>
          ShopeeAdsService.get_product_level_campaign_setting_info({
            accessToken,
            shopId: shop.shopId,
            infoTypeList: [1, 2, 3, 4],
            campaignIdList: [String(campaignId)],
          }),
      }),
      buildMonthlyAdsCostIndex({ shopId: shop.id }),
      listAdsMetricsGroupedByItemId(shop.id, rangeStart, rangeEnd),
    ]);

    const settingsList = Array.isArray(rawSettings?.response?.campaign_list)
      ? rawSettings.response.campaign_list
      : [];

    const set0 = settingsList[0] || {};
    const common0 = set0.common_info || {};
    const itemIds = Array.isArray(common0.item_id_list)
      ? common0.item_id_list.map((x) => String(x))
      : [];

    const autoInfo = Array.isArray(set0.auto_product_ads_info)
      ? set0.auto_product_ads_info
      : [];
    const autoMap = new Map(
      autoInfo
        .filter((x) => x?.item_id != null)
        .map((x) => [String(x.item_id), x]),
    );

    // 2) Enrichment no DB (title + 1 imagem)
    const products = itemIds.length
      ? await listProductsByShopAndItemIds(shop.id, itemIds)
      : [];

    const productByItemId = new Map(
      products.map((p) => [
        String(p.itemId),
        { title: p.title || null, image_url: p.images?.[0]?.url || null },
      ]),
    );

    const dbItemPerformanceMap = new Map(
      (Array.isArray(itemMetricRows) ? itemMetricRows : [])
        .filter((row) => row?.itemId != null)
        .map((row) => [
          String(row.itemId),
          {
            impression: Number(row?._sum?.impression || 0),
            clicks: Number(row?._sum?.click || 0),
            expense: Number(row?._sum?.expense || 0) / 100,
            gmv:
              pickPreferredMetric(row?._sum?.broadGmv, row?._sum?.directGmv) /
              100,
            conversions: pickPreferredMetric(
              row?._sum?.broadSold,
              row?._sum?.directSold,
            ),
            items: pickPreferredMetric(
              row?._sum?.broadSold,
              row?._sum?.directSold,
            ),
          },
        ]),
    );

    // 3) Monta items base (settings + DB). Métricas vêm na próxima etapa via Shopee endpoint de item-performance.
    const itemsBase = itemIds.map((itemId) => {
      const p = productByItemId.get(String(itemId)) || {};
      const ai = autoMap.get(String(itemId)) || {};
      const dbPerf = dbItemPerformanceMap.get(String(itemId)) || {};
      const monthly = monthlyAdsCost.byItemId.get(String(itemId));
      return {
        item_id: String(itemId),
        title: p.title || null,
        image_url: p.image_url || null,
        product_name: ai.product_name || null,
        status: ai.status || null,
        monthly_ad_spend: Number(monthly?.monthlySpendCents || 0) / 100,
        monthly_sales_qty: Number(monthly?.monthlySoldQty || 0),
        monthly_cost_per_sale: Number(monthly?.costPerSaleCents || 0) / 100,
        ads_cost_reference_month: String(dateFrom).slice(0, 7),
        impression:
          Number.isFinite(Number(dbPerf?.impression)) && Number(dbPerf.impression) > 0
            ? Number(dbPerf.impression)
            : null,
        clicks:
          Number.isFinite(Number(dbPerf?.clicks)) && Number(dbPerf.clicks) > 0
            ? Number(dbPerf.clicks)
            : null,
        expense:
          Number.isFinite(Number(dbPerf?.expense)) && Number(dbPerf.expense) > 0
            ? Number(dbPerf.expense)
            : null,
        gmv:
          Number.isFinite(Number(dbPerf?.gmv)) && Number(dbPerf.gmv) > 0
            ? Number(dbPerf.gmv)
            : null,
        conversions:
          Number.isFinite(Number(dbPerf?.conversions)) &&
          Number(dbPerf.conversions) > 0
            ? Number(dbPerf.conversions)
            : null,
        items:
          Number.isFinite(Number(dbPerf?.items)) && Number(dbPerf.items) > 0
            ? Number(dbPerf.items)
            : null,
      };
    });

    // 4) PERFORMANCE: tenta buscar métricas por item via endpoint configurável
    let performanceReady = itemsBase.some(
      (item) =>
        Number(item?.impression || 0) > 0 ||
        Number(item?.clicks || 0) > 0 ||
        Number(item?.expense || 0) > 0 ||
        Number(item?.gmv || 0) > 0,
    );

    try {
      const perfList = [];
      let offset = 0;
      const limit = 100;
      let hasNextPage = true;

      while (hasNextPage) {
        const perfRaw = await callAdsWithAutoRefresh({
          shop,
          call: (accessToken) =>
            ShopeeAdsService.get_cpc_item_performance({
              accessToken,
              shopId: shop.shopId,
              payload: {
                campaign_id: Number(campaignId),
                start_date: startDate,
                end_date: endDate,
                offset,
                limit,
              },
            }).catch(() =>
              ShopeeAdsService.get_gms_item_performance({
                accessToken,
                shopId: shop.shopId,
                payload: {
                  campaign_id: Number(campaignId),
                  start_date: startDate,
                  end_date: endDate,
                  offset,
                  limit,
                },
              }),
            ),
        });

        const resp = perfRaw?.response || {};
        const list =
          (Array.isArray(resp.result_list) && resp.result_list) ||
          (Array.isArray(resp.items) && resp.items) ||
          (Array.isArray(resp.item_list) && resp.item_list) ||
          [];

        perfList.push(...list);

        hasNextPage = Boolean(resp.has_next_page) && list.length > 0;
        offset += list.length || limit;

        if (list.length === 0) break;
      }

      const perfByItemId = new Map();

      for (const row of perfList) {
        const itemId =
          row?.item_id != null
            ? String(row.item_id)
            : row?.itemId != null
              ? String(row.itemId)
              : null;

        if (!itemId) continue;

        const r = row?.report || row?.metrics || row || {};

        const impression = pickMetricField(r, [
          "impression",
          "impressions",
          "impression_count",
          "impressionCount",
          "view_count",
          "views",
        ]);
        const clicks = pickMetricField(r, [
          "clicks",
          "click",
          "click_count",
          "clickCount",
        ]);
        const expense = pickMetricField(r, ["expense", "cost", "ad_spend"]);

        const gmv = pickMetricField(r, [
          "direct_gmv",
          "gmv",
          "broad_gmv",
          "directGmv",
          "broadGmv",
        ]);

        const conversions = pickMetricField(r, [
          "direct_order",
          "order",
          "orders",
          "conversions",
          "conversion_count",
        ]);

        const itemsSold = pickMetricField(r, [
          "direct_item_sold",
          "item_sold",
          "items",
          "item_cnt",
          "sold",
          "sold_count",
        ]);

        perfByItemId.set(itemId, {
          impression,
          clicks,
          expense,
          gmv,
          conversions,
          items: itemsSold,
        });
      }

      for (const it of itemsBase) {
        const perf = perfByItemId.get(String(it.item_id));
        if (!perf) continue;

        it.impression = perf.impression ?? it.impression;
        it.clicks = perf.clicks ?? it.clicks;
        it.expense = perf.expense ?? it.expense;
        it.gmv = perf.gmv ?? it.gmv;
        it.conversions = perf.conversions ?? it.conversions;
        it.items = perf.items ?? it.items;
      }

      performanceReady = true;
    } catch (_) {
      performanceReady = itemsBase.some(
        (item) =>
          Number(item?.impression || 0) > 0 ||
          Number(item?.clicks || 0) > 0 ||
          Number(item?.expense || 0) > 0 ||
          Number(item?.gmv || 0) > 0,
      );
    }

    for (const it of itemsBase) {
      it.ads_cost_reference_month = `${monthlyAdsCost.range.start.getUTCFullYear()}-${String(
        monthlyAdsCost.range.start.getUTCMonth() + 1,
      ).padStart(2, "0")}`;
    }

    return res.json({
      request_id: rawSettings?.request_id,
      warning: rawSettings?.warning,
      error: rawSettings?.error || "",
      message: rawSettings?.message,
      response: {
        campaign_id: String(campaignId),
        date_from: String(dateFrom),
        date_to: String(dateTo),

        // o front vai renderizar esta lista
        items: itemsBase,

        // debug/controle (não obrigatório, mas ajuda na UI enquanto integra métricas)
        performance_ready: performanceReady,
      },
    });
  } catch (e) {
    next(e);
  }
}

function toTsStart(isoDate) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  return Math.floor(d.getTime() / 1000);
}

function toTsEnd(isoDate) {
  const d = new Date(`${isoDate}T23:59:59.999Z`);
  return Math.floor(d.getTime() / 1000);
}

async function hourlyPerformance(req, res, next) {
  try {
    const shop = await resolveShop(req, req.params.shopId);

    const { dateFrom, dateTo } = req.query;
    if (!dateFrom || !dateTo) {
      return res.status(400).json({
        error: { message: "dateFrom/dateTo são obrigatórios (YYYY-MM-DD)." },
      });
    }
    if (String(dateFrom) !== String(dateTo)) {
      return res.status(400).json({
        error: {
          message:
            "Endpoint hourly aceita apenas 1 dia. Use dateFrom=dateTo (YYYY-MM-DD).",
        },
      });
    }

    const performanceDate = toShopeeDate(dateFrom); // vira "DD-MM-YYYY"
    if (!performanceDate) {
      return res.status(400).json({
        error: { message: "dateFrom inválido. Use YYYY-MM-DD." },
      });
    }

    const raw = await callAdsWithAutoRefresh({
      shop,
      call: (accessToken) =>
        ShopeeAdsService.get_all_cpc_ads_hourly_performance({
          accessToken,
          shopId: shop.shopId,
          performanceDate,
        }),
    });

    return res.json(raw);
  } catch (e) {
    if (sendAdsConnectionError(res, e)) return;
    return next(e);
  }
}

function fmtIsoDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseIsoDateOrNull(value) {
  if (!value) return null;
  const d = new Date(`${String(value)}T00:00:00.000Z`);
  if (!Number.isFinite(d.getTime())) return null;
  return d;
}

function daysDiffInclusive(start, end) {
  const ms = end.getTime() - start.getTime();
  return Math.floor(ms / 86400000) + 1;
}

function listIsoDaysInclusive(start, end) {
  const out = [];
  let cursor = new Date(start.getTime());
  while (cursor.getTime() <= end.getTime()) {
    out.push(fmtIsoDate(cursor));
    cursor = new Date(cursor.getTime() + 86400000);
  }
  return out;
}

function normalizeAdsDateRange(dateFromRaw, dateToRaw) {
  const today = new Date();
  const todayUtc = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );

  const parsedTo = parseIsoDateOrNull(dateToRaw) || todayUtc;
  const parsedFrom = parseIsoDateOrNull(dateFromRaw);
  const computedFrom =
    parsedFrom ||
    new Date(parsedTo.getTime() - (30 - 1) * 86400000);

  let start = computedFrom;
  let end = parsedTo;
  if (start.getTime() > end.getTime()) {
    const swap = start;
    start = end;
    end = swap;
  }

  const maxRange = 31;
  const totalDays = daysDiffInclusive(start, end);
  let truncated = false;
  if (totalDays > maxRange) {
    start = new Date(end.getTime() - (maxRange - 1) * 86400000);
    truncated = true;
  }

  return {
    start,
    end,
    dateFrom: fmtIsoDate(start),
    dateTo: fmtIsoDate(end),
    totalDays: daysDiffInclusive(start, end),
    truncated,
  };
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function createCampaignAccumulator(campaignId) {
  return {
    campaign_id: String(campaignId),
    ad_name: null,
    ad_type: null,
    campaign_placement: null,
    campaign_status: null,
    campaign_budget: null,
    metrics_30d: {
      impression: 0,
      clicks: 0,
      expense: 0,
      broad_gmv: 0,
      direct_gmv: 0,
      broad_order: 0,
      direct_order: 0,
      broad_order_amount: 0,
      direct_order_amount: 0,
    },
    _hourlyMap: new Map(),
    _hourProfileMap: new Map(),
  };
}

function isNoReturnHour(hourly) {
  const broadGmv = safeNumber(hourly?.broad_gmv || 0, 0);
  const directGmv = safeNumber(hourly?.direct_gmv || 0, 0);
  const broadRoas = safeNumber(hourly?.broad_roi || 0, 0);
  const directRoas = safeNumber(hourly?.direct_roi || 0, 0);
  return (
    broadGmv <= 0 &&
    directGmv <= 0 &&
    broadRoas <= 0 &&
    directRoas <= 0
  );
}

function applyMetricInAccumulator(acc, metric) {
  acc.metrics_30d.impression += safeNumber(metric?.impression || 0, 0);
  acc.metrics_30d.clicks += safeNumber(metric?.clicks || 0, 0);
  acc.metrics_30d.expense += safeNumber(metric?.expense || 0, 0);
  acc.metrics_30d.broad_gmv += safeNumber(metric?.broad_gmv || 0, 0);
  acc.metrics_30d.direct_gmv += safeNumber(metric?.direct_gmv || 0, 0);
  acc.metrics_30d.broad_order += safeNumber(metric?.broad_order || 0, 0);
  acc.metrics_30d.direct_order += safeNumber(metric?.direct_order || 0, 0);
  acc.metrics_30d.broad_order_amount += safeNumber(
    metric?.broad_order_amount || 0,
    0,
  );
  acc.metrics_30d.direct_order_amount += safeNumber(
    metric?.direct_order_amount || 0,
    0,
  );
}

function addHourlyMetricInAccumulator(acc, metric) {
  const hour = safeNumber(metric?.hour, 0);
  const hourInt = Math.max(0, Math.min(23, Math.trunc(hour)));
  const date = isoDayFromShopee(metric?.date) || null;
  const key = `${date || "unknown"}#${String(hourInt).padStart(2, "0")}`;

  const existing =
    acc._hourlyMap.get(key) ||
    {
      date,
      hour: hourInt,
      impression: 0,
      clicks: 0,
      expense: 0,
      broad_gmv: 0,
      direct_gmv: 0,
      broad_order: 0,
      direct_order: 0,
      broad_order_amount: 0,
      direct_order_amount: 0,
      broad_roi: 0,
      direct_roi: 0,
      no_return: false,
    };

  existing.impression += safeNumber(metric?.impression || 0, 0);
  existing.clicks += safeNumber(metric?.clicks || 0, 0);
  existing.expense += safeNumber(metric?.expense || 0, 0);
  existing.broad_gmv += safeNumber(metric?.broad_gmv || 0, 0);
  existing.direct_gmv += safeNumber(metric?.direct_gmv || 0, 0);
  existing.broad_order += safeNumber(metric?.broad_order || 0, 0);
  existing.direct_order += safeNumber(metric?.direct_order || 0, 0);
  existing.broad_order_amount += safeNumber(metric?.broad_order_amount || 0, 0);
  existing.direct_order_amount += safeNumber(
    metric?.direct_order_amount || 0,
    0,
  );

  existing.broad_roi =
    existing.expense > 0 ? existing.broad_gmv / existing.expense : 0;
  existing.direct_roi =
    existing.expense > 0 ? existing.direct_gmv / existing.expense : 0;
  existing.no_return = isNoReturnHour(existing);

  acc._hourlyMap.set(key, existing);

  const hp =
    acc._hourProfileMap.get(hourInt) ||
    {
      hour: hourInt,
      entries: 0,
      no_return_entries: 0,
      impression: 0,
      clicks: 0,
      expense: 0,
      broad_gmv: 0,
      direct_gmv: 0,
      broad_order: 0,
      direct_order: 0,
    };
  hp.entries += 1;
  if (existing.no_return) hp.no_return_entries += 1;
  hp.impression += safeNumber(metric?.impression || 0, 0);
  hp.clicks += safeNumber(metric?.clicks || 0, 0);
  hp.expense += safeNumber(metric?.expense || 0, 0);
  hp.broad_gmv += safeNumber(metric?.broad_gmv || 0, 0);
  hp.direct_gmv += safeNumber(metric?.direct_gmv || 0, 0);
  hp.broad_order += safeNumber(metric?.broad_order || 0, 0);
  hp.direct_order += safeNumber(metric?.direct_order || 0, 0);
  acc._hourProfileMap.set(hourInt, hp);
}

function finalizeCampaignAccumulator(acc) {
  const hourly = Array.from(acc._hourlyMap.values()).sort((a, b) => {
    if (a.date === b.date) return a.hour - b.hour;
    return String(a.date || "").localeCompare(String(b.date || ""));
  });

  const hour_profile = Array.from(acc._hourProfileMap.values())
    .sort((a, b) => a.hour - b.hour)
    .map((h) => {
      const noReturnRatio = h.entries
        ? Number((h.no_return_entries / h.entries).toFixed(4))
        : 0;
      const hasReturnRatio = Number((1 - noReturnRatio).toFixed(4));
      return {
        hour: h.hour,
        entries: h.entries,
        no_return_entries: h.no_return_entries,
        no_return_ratio: noReturnRatio,
        has_return_ratio: hasReturnRatio,
        impression: h.impression,
        clicks: h.clicks,
        expense: Number(h.expense.toFixed(4)),
        broad_gmv: Number(h.broad_gmv.toFixed(4)),
        direct_gmv: Number(h.direct_gmv.toFixed(4)),
        broad_order: h.broad_order,
        direct_order: h.direct_order,
        broad_roi: h.expense > 0 ? Number((h.broad_gmv / h.expense).toFixed(4)) : 0,
        direct_roi:
          h.expense > 0 ? Number((h.direct_gmv / h.expense).toFixed(4)) : 0,
      };
    });

  return {
    campaign_id: acc.campaign_id,
    ad_name: acc.ad_name,
    ad_type: acc.ad_type,
    campaign_placement: acc.campaign_placement,
    campaign_status: acc.campaign_status,
    campaign_budget: acc.campaign_budget,
    metrics_30d: {
      ...acc.metrics_30d,
      broad_roi:
        acc.metrics_30d.expense > 0
          ? Number((acc.metrics_30d.broad_gmv / acc.metrics_30d.expense).toFixed(4))
          : 0,
      direct_roi:
        acc.metrics_30d.expense > 0
          ? Number((acc.metrics_30d.direct_gmv / acc.metrics_30d.expense).toFixed(4))
          : 0,
      ctr:
        acc.metrics_30d.impression > 0
          ? Number(
              ((acc.metrics_30d.clicks / acc.metrics_30d.impression) * 100).toFixed(4),
            )
          : 0,
    },
    hourly,
    hour_profile,
  };
}

async function buildAdsIntelligenceDataset({
  shop,
  dateFrom,
  dateTo,
  campaignIdsFilter = [],
}) {
  const range = normalizeAdsDateRange(dateFrom, dateTo);
  const dateRanges = chunkIsoDateRange(range.dateFrom, range.dateTo);
  const warnings = [];
  if (range.truncated) {
    warnings.push(
      "Período solicitado excedia 31 dias e foi ajustado automaticamente para os últimos 31 dias.",
    );
  }

  const [balanceRaw, toggleRaw, idsResp] = await Promise.all([
    callAdsWithAutoRefresh({
      shop,
      call: (accessToken) =>
        ShopeeAdsService.get_total_balance({
          accessToken,
          shopId: shop.shopId,
        }),
    }).catch(() => null),
    callAdsWithAutoRefresh({
      shop,
      call: (accessToken) =>
        ShopeeAdsService.get_shop_toggle_info({
          accessToken,
          shopId: shop.shopId,
        }),
    }).catch(() => null),
    callAdsWithAutoRefresh({
      shop,
      call: (accessToken) =>
        ShopeeAdsService.get_product_level_campaign_id_list({
          accessToken,
          shopId: shop.shopId,
          adType: "",
          offset: 0,
          limit: 5000,
        }),
    }),
  ]);

  const allCampaignIds = Array.isArray(idsResp?.response?.campaign_list)
    ? idsResp.response.campaign_list
        .map((c) => String(c?.campaign_id || ""))
        .filter(Boolean)
    : [];

  const filterSet = new Set(
    (Array.isArray(campaignIdsFilter) ? campaignIdsFilter : [])
      .map((x) => String(x || "").trim())
      .filter(Boolean),
  );

  const campaignIds = filterSet.size
    ? allCampaignIds.filter((id) => filterSet.has(String(id)))
    : allCampaignIds;

  const settingsMap = new Map();
  for (const batch of chunk(campaignIds, 100)) {
    const settingsRaw = await callAdsWithAutoRefresh({
      shop,
      call: (accessToken) =>
        ShopeeAdsService.get_product_level_campaign_setting_info({
          accessToken,
          shopId: shop.shopId,
          infoTypeList: [1, 2, 3, 4],
          campaignIdList: batch,
        }),
    }).catch(() => null);

    const campaigns = Array.isArray(settingsRaw?.response?.campaign_list)
      ? settingsRaw.response.campaign_list
      : [];
    for (const c of campaigns) {
      settingsMap.set(String(c?.campaign_id), c || {});
    }
  }

  const accMap = new Map();
  const ensureAcc = (campaignId) => {
    const key = String(campaignId);
    if (!accMap.has(key)) accMap.set(key, createCampaignAccumulator(key));
    const acc = accMap.get(key);
    const settings = settingsMap.get(key);
    const common = settings?.common_info || {};
    if (common) {
      if (!acc.ad_name && common.ad_name) acc.ad_name = common.ad_name;
      if (!acc.ad_type && common.ad_type) acc.ad_type = common.ad_type;
      if (!acc.campaign_placement && common.campaign_placement)
        acc.campaign_placement = common.campaign_placement;
      if (!acc.campaign_status && common.campaign_status)
        acc.campaign_status = common.campaign_status;
      if (acc.campaign_budget == null && common.campaign_budget != null)
        acc.campaign_budget = Number(common.campaign_budget);
    }
    return acc;
  };

  campaignIds.forEach((campaignId) => ensureAcc(campaignId));

  if (campaignIds.length && range.totalDays > 1) {
    for (const dateRange of dateRanges) {
      for (const batch of chunk(campaignIds, 100)) {
        const dailyRaw = await callAdsWithAutoRefresh({
          shop,
          call: (accessToken) =>
            ShopeeAdsService.get_product_campaign_daily_performance({
              accessToken,
              shopId: shop.shopId,
              startDate: toShopeeDate(dateRange.from),
              endDate: toShopeeDate(dateRange.to),
              campaignIdList: batch,
            }),
        }).catch(() => null);

      const blocks = Array.isArray(dailyRaw?.response)
        ? dailyRaw.response
        : dailyRaw?.response
          ? [dailyRaw.response]
          : [];

        for (const shopBlock of blocks) {
          const cList = Array.isArray(shopBlock?.campaign_list)
            ? shopBlock.campaign_list
            : [];
          for (const c of cList) {
            const acc = ensureAcc(c?.campaign_id);
            if (c?.ad_name) acc.ad_name = c.ad_name;
            if (c?.ad_type) acc.ad_type = c.ad_type;
            if (c?.campaign_placement) acc.campaign_placement = c.campaign_placement;
            const mList = Array.isArray(c?.metrics_list) ? c.metrics_list : [];
            for (const m of mList) {
              applyMetricInAccumulator(acc, m || {});
            }
          }
        }
      }
    }
  }

  const isoDays = listIsoDaysInclusive(range.start, range.end);
  for (const isoDay of isoDays) {
    const performanceDate = toShopeeDate(isoDay);
    for (const batch of chunk(campaignIds, 100)) {
      const hourlyRaw = await callAdsWithAutoRefresh({
        shop,
        call: (accessToken) =>
          ShopeeAdsService.get_product_campaign_hourly_performance({
            accessToken,
            shopId: shop.shopId,
            performanceDate,
            campaignIdList: batch,
          }),
      }).catch(() => null);

      const blocks = Array.isArray(hourlyRaw?.response)
        ? hourlyRaw.response
        : hourlyRaw?.response
          ? [hourlyRaw.response]
          : [];

      for (const shopBlock of blocks) {
        const cList = Array.isArray(shopBlock?.campaign_list)
          ? shopBlock.campaign_list
          : [];
        for (const c of cList) {
          const acc = ensureAcc(c?.campaign_id);
          if (c?.ad_name) acc.ad_name = c.ad_name;
          if (c?.ad_type) acc.ad_type = c.ad_type;
          if (c?.campaign_placement) acc.campaign_placement = c.campaign_placement;
          const metrics = Array.isArray(c?.metrics_list) ? c.metrics_list : [];
          for (const metric of metrics) {
            addHourlyMetricInAccumulator(acc, metric || {});
          }
        }
      }
    }
  }

  const campaigns = Array.from(accMap.values()).map(finalizeCampaignAccumulator);
  campaigns.sort(
    (a, b) => Number(b?.metrics_30d?.expense || 0) - Number(a?.metrics_30d?.expense || 0),
  );

  return {
    feature_status: "EM_TESTE",
    caution:
      "Funcionalidade em teste. Revise as recomendações antes de aplicar ações automáticas de Ads.",
    period: {
      date_from: range.dateFrom,
      date_to: range.dateTo,
      total_days: range.totalDays,
    },
    warnings,
    shop_toggle: {
      data_timestamp: toggleRaw?.response?.data_timestamp || null,
      auto_top_up: toggleRaw?.response?.auto_top_up ?? null,
      campaign_surge: toggleRaw?.response?.campaign_surge ?? null,
    },
    ads_balance: {
      data_timestamp: balanceRaw?.response?.data_timestamp || null,
      total_balance: balanceRaw?.response?.total_balance ?? null,
    },
    campaigns,
  };
}

function buildIntelligencePlanFromDataset(dataset, options = {}) {
  const mode = String(options?.mode || "reduce_percent");
  const reducePercentRaw = Number(options?.reduce_percent);
  const reducePercent = Number.isFinite(reducePercentRaw)
    ? Math.max(0, Math.min(95, reducePercentRaw))
    : 25;
  const fixedBudgetRaw = Number(options?.fixed_budget);
  const fixedBudget = Number.isFinite(fixedBudgetRaw) ? Math.max(0, fixedBudgetRaw) : 5;
  const restoreMode = String(options?.restore_mode || "original");
  const restoreBudgetRaw = Number(options?.restore_budget);
  const restoreBudget = Number.isFinite(restoreBudgetRaw)
    ? Math.max(0, restoreBudgetRaw)
    : null;
  const ratioThresholdRaw = Number(options?.no_return_ratio_threshold);
  const noReturnRatioThreshold = Number.isFinite(ratioThresholdRaw)
    ? Math.max(0, Math.min(1, ratioThresholdRaw))
    : 0.7;
  const minClicksRaw = Number(options?.min_clicks_per_hour || 0);
  const minClicksPerHour = Number.isFinite(minClicksRaw) ? Math.max(0, minClicksRaw) : 0;

  const now = new Date();
  const currentHour = now.getHours();
  const plans = [];

  for (const campaign of Array.isArray(dataset?.campaigns) ? dataset.campaigns : []) {
    const baseBudget = Number(campaign?.campaign_budget);
    const hourProfiles = Array.isArray(campaign?.hour_profile) ? campaign.hour_profile : [];
    const hours = [];

    for (let h = 0; h < 24; h += 1) {
      const hp = hourProfiles.find((x) => Number(x?.hour) === h) || {
        hour: h,
        entries: 0,
        no_return_ratio: 0,
        clicks: 0,
      };
      const noReturnHour =
        Number(hp.no_return_ratio || 0) >= noReturnRatioThreshold &&
        Number(hp.clicks || 0) >= minClicksPerHour;

      let noReturnAction = "none";
      let noReturnBudget = null;
      let returnAction = "none";
      let returnBudget = null;

      if (mode === "pause") {
        noReturnAction = "pause";
        returnAction = "resume";
      } else if (mode === "fixed_budget") {
        noReturnAction = "change_budget";
        noReturnBudget = fixedBudget;
      } else {
        noReturnAction = "change_budget";
        if (Number.isFinite(baseBudget) && baseBudget > 0) {
          noReturnBudget = Number((baseBudget * (1 - reducePercent / 100)).toFixed(2));
        } else {
          noReturnBudget = fixedBudget;
        }
      }

      if (mode !== "pause") {
        returnAction = "change_budget";
        if (restoreMode === "fixed" && Number.isFinite(restoreBudget)) {
          returnBudget = restoreBudget;
        } else if (Number.isFinite(baseBudget) && baseBudget > 0) {
          returnBudget = baseBudget;
        } else {
          returnBudget = Number.isFinite(restoreBudget) ? restoreBudget : null;
        }
      }

      const suggested = noReturnHour
        ? {
            type: noReturnAction,
            budget: noReturnBudget,
            reason: "Hora sem retorno histórico de GMV/ROAS.",
          }
        : {
            type: returnAction,
            budget: returnBudget,
            reason: "Hora com retorno histórico ou sem bloqueio de retorno.",
          };

      hours.push({
        hour: h,
        no_return_hour: noReturnHour,
        no_return_ratio: Number(hp.no_return_ratio || 0),
        clicks: Number(hp.clicks || 0),
        entries: Number(hp.entries || 0),
        suggested_action: suggested,
      });
    }

    const currentHourPlan = hours.find((x) => x.hour === currentHour) || null;
    plans.push({
      campaign_id: String(campaign.campaign_id),
      ad_name: campaign.ad_name || null,
      ad_type: campaign.ad_type || null,
      campaign_status: campaign.campaign_status || null,
      campaign_budget: Number.isFinite(baseBudget) ? baseBudget : null,
      current_hour: currentHour,
      current_hour_plan: currentHourPlan,
      hourly_plan: hours,
    });
  }

  return {
    mode,
    reduce_percent: reducePercent,
    fixed_budget: fixedBudget,
    restore_mode: restoreMode,
    restore_budget: restoreBudget,
    no_return_ratio_threshold: noReturnRatioThreshold,
    min_clicks_per_hour: minClicksPerHour,
    current_hour: currentHour,
    campaign_plans: plans,
  };
}

async function intelligenceOverview(req, res, next) {
  try {
    const shop = await resolveShop(req, req.params.shopId);
    const campaignIdsCsv = String(req.query.campaignIds || "");
    const campaignIds = campaignIdsCsv
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    const dataset = await buildAdsIntelligenceDataset({
      shop,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      campaignIdsFilter: campaignIds,
    });
    const automationConfig = await getAutomationConfigByShopId(shop.id).catch(
      () => null,
    );

    return res.json({
      request_id: `ads-intelligence-overview-${Date.now()}`,
      response: {
        ...dataset,
        automation: automationConfig,
      },
    });
  } catch (e) {
    if (sendAdsConnectionError(res, e)) return;
    return next(e);
  }
}

async function intelligenceSimulate(req, res, next) {
  try {
    const shop = await resolveShop(req, req.params.shopId);
    const campaignIds = Array.isArray(req.body?.campaign_ids)
      ? req.body.campaign_ids
      : [];

    const dataset = await buildAdsIntelligenceDataset({
      shop,
      dateFrom: req.body?.dateFrom || req.query?.dateFrom,
      dateTo: req.body?.dateTo || req.query?.dateTo,
      campaignIdsFilter: campaignIds,
    });

    const plan = buildIntelligencePlanFromDataset(dataset, req.body || {});
    const automationConfig = await getAutomationConfigByShopId(shop.id).catch(
      () => null,
    );

    return res.json({
      request_id: `ads-intelligence-simulate-${Date.now()}`,
      response: {
        ...dataset,
        strategy: plan,
        automation: automationConfig,
      },
    });
  } catch (e) {
    if (sendAdsConnectionError(res, e)) return;
    return next(e);
  }
}

async function intelligenceApply(req, res, next) {
  try {
    const shop = await resolveShop(req, req.params.shopId);
    const selectedCampaignIds = Array.isArray(req.body?.campaign_ids)
      ? req.body.campaign_ids.map((x) => String(x)).filter(Boolean)
      : [];

    const dataset = await buildAdsIntelligenceDataset({
      shop,
      dateFrom: req.body?.dateFrom || req.query?.dateFrom,
      dateTo: req.body?.dateTo || req.query?.dateTo,
      campaignIdsFilter: selectedCampaignIds,
    });
    const strategy = buildIntelligencePlanFromDataset(dataset, req.body || {});
    const automationEnabled = false;

    const logs = [];
    const results = [];
    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;

    for (const campaignPlan of strategy.campaign_plans) {
      const campaignId = String(campaignPlan.campaign_id);
      const currentPlan = campaignPlan.current_hour_plan;
      const action = currentPlan?.suggested_action || null;
      if (!action || !action.type || action.type === "none") {
        skippedCount += 1;
        logs.push({
          level: "warning",
          campaign_id: campaignId,
          message: "Sem ação recomendada para a hora atual.",
        });
        results.push({
          campaign_id: campaignId,
          status: "skipped",
          reason: "no_action_current_hour",
        });
        continue;
      }

      const adType = String(campaignPlan.ad_type || "").toLowerCase();
      if (adType && adType !== "manual") {
        skippedCount += 1;
        logs.push({
          level: "warning",
          campaign_id: campaignId,
          message:
            "Campanha não manual. Ação automática de orçamento/pausa não suportada por este fluxo.",
        });
        results.push({
          campaign_id: campaignId,
          status: "skipped",
          reason: "campaign_type_not_manual",
        });
        continue;
      }

      const payload = {
        reference_id: `iaads-${campaignId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        campaign_id: Number(campaignId),
        edit_action: action.type,
      };
      if (action.type === "change_budget") {
        const budget = Number(action.budget);
        if (!Number.isFinite(budget) || budget < 0) {
          skippedCount += 1;
          logs.push({
            level: "warning",
            campaign_id: campaignId,
            message: "Ação de orçamento ignorada por valor inválido.",
          });
          results.push({
            campaign_id: campaignId,
            status: "skipped",
            reason: "invalid_budget",
          });
          continue;
        }
        payload.budget = Number(budget.toFixed(2));
      }

      try {
        const raw = await callAdsWithAutoRefresh({
          shop,
          call: (accessToken) =>
            ShopeeAdsService.edit_manual_product_ads({
              accessToken,
              shopId: shop.shopId,
              payload,
            }),
        });

        successCount += 1;
        logs.push({
          level: "success",
          campaign_id: campaignId,
          message: `Ação aplicada: ${action.type}${
            action.type === "change_budget" ? ` (${payload.budget})` : ""
          }`,
          request_id: raw?.request_id || null,
        });
        results.push({
          campaign_id: campaignId,
          status: "success",
          action: action.type,
          budget: payload.budget ?? null,
          request_id: raw?.request_id || null,
        });
      } catch (error) {
        errorCount += 1;
        const details = getShopeeErrData(error);
        logs.push({
          level: "error",
          campaign_id: campaignId,
          message:
            details?.message ||
            details?.error ||
            error?.message ||
            "Falha ao aplicar ação na campanha.",
          error_code: details?.error || null,
        });
        results.push({
          campaign_id: campaignId,
          status: "error",
          action: action.type,
          message:
            details?.message ||
            details?.error ||
            error?.message ||
            "Falha ao aplicar ação na campanha.",
        });
      }
    }

    logs.push({
      level: "warning",
      campaign_id: null,
      message:
        "Automação da IA Ads está temporariamente fechada/desativada. Apenas aplicação manual foi executada.",
    });

    const savedAutomation = await upsertAutomationConfig({
      shopId: shop.id,
      isEnabled: automationEnabled,
      mode: strategy.mode,
      reducePercent: strategy.reduce_percent,
      fixedBudget: strategy.fixed_budget,
      restoreMode: strategy.restore_mode,
      restoreBudget: strategy.restore_budget,
      noReturnRatioThreshold: strategy.no_return_ratio_threshold,
      minClicksPerHour: strategy.min_clicks_per_hour,
      campaignIds: selectedCampaignIds,
    }).catch((error) => {
      logs.push({
        level: "warning",
        campaign_id: null,
        message:
          error?.message ||
          "Não foi possível salvar a configuração da automação da IA Ads.",
      });
      return null;
    });

    return res.json({
      request_id: `ads-intelligence-apply-${Date.now()}`,
      response: {
        feature_status: "EM_TESTE",
        caution:
          "Funcionalidade em teste. Revise os logs de execução e use com cautela.",
        period: dataset.period,
        strategy,
        summary: {
          total_campaigns: strategy.campaign_plans.length,
          success: successCount,
          errors: errorCount,
          skipped: skippedCount,
        },
        automation: savedAutomation,
        results,
        logs,
      },
    });
  } catch (e) {
    if (sendAdsConnectionError(res, e)) return;
    return next(e);
  }
}

async function roasRealApprox(req, res, next) {
  try {
    const shop = await resolveShop(req, req.params.shopId);

    const { dateFrom, dateTo } = req.query;
    if (!dateFrom || !dateTo) {
      return res.status(400).json({
        error: { message: "dateFrom/dateTo são obrigatórios (YYYY-MM-DD)." },
      });
    }

    const tzOffset = process.env.SHOPEE_REPORT_TZ_OFFSET || "-03:00";

    // intervalo no “dia local” do relatório
    const start = new Date(`${dateFrom}T00:00:00.000${tzOffset}`);
    const end = new Date(`${dateTo}T23:59:59.999${tzOffset}`);

    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
      return res.status(400).json({
        error: { message: "dateFrom/dateTo inválidos. Use YYYY-MM-DD." },
      });
    }

    const previousDateFrom = shiftIsoMonthClamped(dateFrom, -1);
    const previousDateTo = shiftIsoMonthClamped(dateTo, -1);

    if (!previousDateFrom || !previousDateTo) {
      return res.status(400).json({
        error: { message: "dateFrom/dateTo invalidos para comparacao MoM." },
      });
    }

    const previousStart = new Date(
      `${previousDateFrom}T00:00:00.000${tzOffset}`,
    );
    const previousEnd = new Date(
      `${previousDateTo}T23:59:59.999${tzOffset}`,
    );

    const [current, previous] = await Promise.all([
      collectRoasMetricsForRange({
        shop,
        shopDbId: shop.id,
        start,
        end,
        dateFrom,
        dateTo,
      }),
      collectRoasMetricsForRange({
        shop,
        shopDbId: shop.id,
        start: previousStart,
        end: previousEnd,
        dateFrom: previousDateFrom,
        dateTo: previousDateTo,
      }),
    ]);

    return res.json({
      request: {
        dateFrom: String(dateFrom),
        dateTo: String(dateTo),
        tzOffset,
        compare: {
          mode: "mom",
          previousDateFrom,
          previousDateTo,
        },
      },
      source: {
        adsTotals: current.sourceAdsTotals,
        adsTotalsPrevious: previous.sourceAdsTotals,
        storeGmv: "paid_orders",
      },
      metrics: current.metrics,
      counts: current.counts,
      mom: {
        previous: {
          metrics: previous.metrics,
          counts: previous.counts,
        },
        delta: {
          spendCents:
            Number(current.metrics.spendCents || 0) -
            Number(previous.metrics.spendCents || 0),
          spendPct: pctDelta(
            current.metrics.spendCents,
            previous.metrics.spendCents,
          ),
          tacosPp:
            current.metrics.tacosPct == null || previous.metrics.tacosPct == null
              ? null
              : Number(
                  (current.metrics.tacosPct - previous.metrics.tacosPct).toFixed(2),
                ),
          ordersMatched:
            Number(current.counts.ordersMatched || 0) -
            Number(previous.counts.ordersMatched || 0),
          ordersMatchedPct: pctDelta(
            current.counts.ordersMatched,
            previous.counts.ordersMatched,
          ),
          adsRevenueSharePp:
            current.metrics.adsRevenueSharePct == null ||
            previous.metrics.adsRevenueSharePct == null
              ? null
              : Number(
                  (
                    current.metrics.adsRevenueSharePct -
                    previous.metrics.adsRevenueSharePct
                  ).toFixed(2),
                ),
        },
      },
    });
  } catch (e) {
    console.error("[AdsController.roasRealApprox] failed", {
      message: e?.message,
      code: e?.code,
      meta: e?.meta,
    });
    return next(e);
  }
}

module.exports = {
  balance,
  dailyPerformance,
  hourlyPerformance,
  intelligenceOverview,
  intelligenceSimulate,
  intelligenceApply,
  roasRealApprox,
  listCampaignIds,
  groupedCampaigns,
  campaignsDailyPerformance,
  campaignSettings,
  campaignItemsPerformance,
  toTsEnd,
  toTsStart,
  _test: { normalizeAdsDateRange },
};
