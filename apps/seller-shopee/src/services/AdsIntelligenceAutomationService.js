"use strict";

const ShopeeAdsService = require("./ShopeeAdsService");
const {
  callAdsWithAutoRefresh,
  getShopeeErrData,
} = require("./ShopeeAdsTokenService");
const {
  listEnabledAutomationConfigsWithShops,
  updateAutomationRunResult,
} = require("../repositories/adsIntelligenceAutomationSqlRepository");
const { chunkIsoDateRange } = require("./AdsRoasMetricsService");

function toShopeeDate(iso) {
  const [y, m, d] = String(iso || "").split("-");
  if (!y || !m || !d) return null;
  return `${d}-${m}-${y}`;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function fmtIsoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseIsoDateOrNull(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function daysDiffInclusive(start, end) {
  const a = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const b = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  const diffMs = b.getTime() - a.getTime();
  return Math.floor(diffMs / 86400000) + 1;
}

function listIsoDaysInclusive(start, end) {
  const out = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cursor.getTime() <= last.getTime()) {
    out.push(fmtIsoDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function normalizeAdsDateRange(dateFrom, dateTo) {
  const now = new Date();
  const endInput = parseIsoDateOrNull(dateTo) || now;
  const end = new Date(
    endInput.getFullYear(),
    endInput.getMonth(),
    endInput.getDate(),
  );
  const startInput = parseIsoDateOrNull(dateFrom);
  let start = startInput
    ? new Date(startInput.getFullYear(), startInput.getMonth(), startInput.getDate())
    : new Date(end.getFullYear(), end.getMonth(), end.getDate() - 29);

  if (start.getTime() > end.getTime()) {
    start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 29);
  }

  let totalDays = daysDiffInclusive(start, end);
  let truncated = false;
  if (totalDays > 31) {
    start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 30);
    totalDays = 31;
    truncated = true;
  }
  return {
    start,
    end,
    dateFrom: fmtIsoDate(start),
    dateTo: fmtIsoDate(end),
    totalDays,
    truncated,
  };
}

function safeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
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
    hourly: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      clicks: 0,
      expense: 0,
      broad_gmv: 0,
      direct_gmv: 0,
      broad_order: 0,
      direct_order: 0,
      entries: 0,
      no_return_count: 0,
    })),
  };
}

function isNoReturnHour(metric) {
  const broadGmv = safeNumber(metric?.broad_gmv ?? metric?.broad_gmv_cents);
  const directGmv = safeNumber(metric?.direct_gmv ?? metric?.direct_gmv_cents);
  const broadRoi = safeNumber(metric?.broad_roi ?? metric?.broad_roas);
  const directRoi = safeNumber(metric?.direct_roi ?? metric?.direct_roas);
  const broadOrders = safeNumber(metric?.broad_order);
  const directOrders = safeNumber(metric?.direct_order);

  const hasGmv = broadGmv > 0 || directGmv > 0;
  const hasRoi = broadRoi > 0 || directRoi > 0;
  const hasOrders = broadOrders > 0 || directOrders > 0;
  return !hasGmv && !hasRoi && !hasOrders;
}

function applyMetricInAccumulator(acc, metric) {
  acc.metrics_30d.impression += safeNumber(metric?.impression);
  acc.metrics_30d.clicks += safeNumber(metric?.clicks);
  acc.metrics_30d.expense += safeNumber(metric?.expense);
  acc.metrics_30d.broad_gmv += safeNumber(metric?.broad_gmv);
  acc.metrics_30d.direct_gmv += safeNumber(metric?.direct_gmv);
  acc.metrics_30d.broad_order += safeNumber(metric?.broad_order);
  acc.metrics_30d.direct_order += safeNumber(metric?.direct_order);
  acc.metrics_30d.broad_order_amount += safeNumber(metric?.broad_order_amount);
  acc.metrics_30d.direct_order_amount += safeNumber(metric?.direct_order_amount);
}

function addHourlyMetricInAccumulator(acc, metric) {
  const hour = safeNumber(metric?.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return;
  const slot = acc.hourly[hour];
  slot.clicks += safeNumber(metric?.clicks);
  slot.expense += safeNumber(metric?.expense);
  slot.broad_gmv += safeNumber(metric?.broad_gmv);
  slot.direct_gmv += safeNumber(metric?.direct_gmv);
  slot.broad_order += safeNumber(metric?.broad_order);
  slot.direct_order += safeNumber(metric?.direct_order);
  slot.entries += 1;
  if (isNoReturnHour(metric)) slot.no_return_count += 1;
}

function finalizeCampaignAccumulator(acc) {
  const hourly = acc.hourly.map((slot) => ({
    hour: slot.hour,
    clicks: slot.clicks,
    expense: slot.expense,
    broad_gmv: slot.broad_gmv,
    direct_gmv: slot.direct_gmv,
    broad_order: slot.broad_order,
    direct_order: slot.direct_order,
    entries: slot.entries,
    no_return_count: slot.no_return_count,
    no_return_ratio:
      slot.entries > 0 ? Number((slot.no_return_count / slot.entries).toFixed(4)) : 0,
  }));

  const hourProfile = hourly.map((slot) => ({
    hour: slot.hour,
    entries: slot.entries,
    no_return_ratio: slot.no_return_ratio,
    clicks: slot.clicks,
  }));

  return {
    campaign_id: acc.campaign_id,
    ad_name: acc.ad_name || null,
    ad_type: acc.ad_type || null,
    campaign_placement: acc.campaign_placement || null,
    campaign_status: acc.campaign_status || null,
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
    hour_profile: hourProfile,
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

  const idsResp = await callAdsWithAutoRefresh({
    shop,
    call: (accessToken) =>
      ShopeeAdsService.get_product_level_campaign_id_list({
        accessToken,
        shopId: shop.shopId,
        adType: "",
        offset: 0,
        limit: 5000,
      }),
  });

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
    options: {
      reduce_percent: reducePercent,
      fixed_budget: fixedBudget,
      restore_mode: restoreMode,
      restore_budget: restoreBudget,
      no_return_ratio_threshold: noReturnRatioThreshold,
      min_clicks_per_hour: minClicksPerHour,
    },
    generated_at: new Date().toISOString(),
    campaign_plans: plans,
  };
}

async function applyIntelligenceForCurrentHour({ shop, strategy }) {
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
      reference_id: `iaads-auto-${campaignId}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 9)}`,
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

  return {
    summary: {
      total_campaigns: strategy.campaign_plans.length,
      success: successCount,
      errors: errorCount,
      skipped: skippedCount,
    },
    logs,
    results,
  };
}

async function runAutomationForShop({ shop, config }) {
  const dataset = await buildAdsIntelligenceDataset({
    shop,
    campaignIdsFilter: config.campaignIds || [],
  });

  const strategy = buildIntelligencePlanFromDataset(dataset, {
    mode: config.mode,
    reduce_percent: config.reducePercent,
    fixed_budget: config.fixedBudget,
    restore_mode: config.restoreMode,
    restore_budget: config.restoreBudget,
    no_return_ratio_threshold: config.noReturnRatioThreshold,
    min_clicks_per_hour: config.minClicksPerHour,
  });

  const applied = await applyIntelligenceForCurrentHour({ shop, strategy });
  return {
    period: dataset.period,
    strategy,
    ...applied,
  };
}

async function runScheduledAutomation() {
  const enabled = await listEnabledAutomationConfigsWithShops();
  let processedShops = 0;
  let okShops = 0;
  let failedShops = 0;
  const details = [];

  for (const row of enabled) {
    const shop = row.shop;
    const config = row.config;
    processedShops += 1;

    try {
      const execution = await runAutomationForShop({ shop, config });
      okShops += 1;
      await updateAutomationRunResult(shop.id, {
        status: "success",
        summary: execution.summary,
      });
      details.push({
        shop_id: shop.id,
        shopee_shop_id: shop.shopId == null ? null : String(shop.shopId),
        status: "success",
        summary: execution.summary,
      });
    } catch (error) {
      failedShops += 1;
      const payload = getShopeeErrData(error);
      const message =
        payload?.message || payload?.error || error?.message || "Falha na automação da IA Ads.";
      await updateAutomationRunResult(shop.id, {
        status: "error",
        summary: {
          message,
        },
      }).catch(() => null);
      details.push({
        shop_id: shop.id,
        shopee_shop_id: shop.shopId == null ? null : String(shop.shopId),
        status: "error",
        message,
      });
    }
  }

  return {
    ok: true,
    processedShops,
    okShops,
    failedShops,
    details,
  };
}

module.exports = {
  buildAdsIntelligenceDataset,
  buildIntelligencePlanFromDataset,
  applyIntelligenceForCurrentHour,
  runAutomationForShop,
  runScheduledAutomation,
  _test: { normalizeAdsDateRange },
};

