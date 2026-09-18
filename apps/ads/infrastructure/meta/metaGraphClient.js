"use strict";

const crypto = require("node:crypto");
const { env } = require("../../config/env");

function toStringValue(value, fallback = "0") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function moneyToMicros(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return "0";
  return String(Math.round(amount * 1_000_000));
}

function actionValueMap(rows) {
  const map = new Map();
  for (const item of rows || []) {
    if (!item?.action_type) continue;
    map.set(String(item.action_type), Number(item.value || 0));
  }
  return map;
}

function parseInsightsRow(row, entityType, accountExternalId) {
  const actions = Array.isArray(row.actions) ? row.actions : [];
  const actionValues = Array.isArray(row.action_values) ? row.action_values : [];
  const values = actionValueMap(actionValues);
  const entityExternalId = entityType === "account"
    ? String(row.account_id || accountExternalId)
    : entityType === "campaign"
      ? String(row.campaign_id || "")
      : entityType === "ad_group"
        ? String(row.adset_id || "")
        : String(row.ad_id || "");

  return {
    metric: {
      metric_date: row.date_start,
      entity_type: entityType,
      entity_external_id: entityExternalId,
      campaign_external_id: row.campaign_id ? String(row.campaign_id) : entityType === "campaign" ? entityExternalId : null,
      ad_group_external_id: row.adset_id ? String(row.adset_id) : entityType === "ad_group" ? entityExternalId : null,
      impressions: toStringValue(row.impressions),
      clicks: toStringValue(row.clicks),
      cost_micros: moneyToMicros(row.spend),
      conversions: "0",
      conversion_value: "0",
      all_conversions: "0",
      all_conversion_value: "0",
      reach: toStringValue(row.reach),
      unique_clicks: toStringValue(row.unique_clicks),
      frequency: toStringValue(row.frequency),
      link_clicks: toStringValue(row.inline_link_clicks),
      outbound_clicks: toStringValue((row.outbound_clicks || [])[0]?.value),
      metadata: {
        actions,
        actionValues,
        objectiveResults: row.objective_results || [],
      },
    },
    actionMetrics: actions.map((item) => ({
      metric_date: row.date_start,
      entity_type: entityType,
      entity_external_id: entityExternalId,
      action_type: String(item.action_type || "unknown"),
      action_count: toStringValue(item.value),
      action_value: toStringValue(values.get(String(item.action_type || "unknown")) || 0),
    })),
  };
}

class MetaGraphClient {
  constructor({ accessToken }) {
    this.accessToken = String(accessToken || "");
    if (!this.accessToken) throw new Error("Meta access token is required");
  }

  buildUrl(pathname, params = {}) {
    const base = `https://graph.facebook.com/${env.metaGraphApiVersion}`;
    const raw = String(pathname || "");
    const url = new URL(raw.startsWith("http") ? raw : `${base}/${raw.replace(/^\/+/, "")}`);
    if (!url.searchParams.has("access_token")) url.searchParams.set("access_token", this.accessToken);
    if (env.metaAppSecret && !url.searchParams.has("appsecret_proof")) {
      const proof = crypto.createHmac("sha256", env.metaAppSecret).update(this.accessToken).digest("hex");
      url.searchParams.set("appsecret_proof", proof);
    }
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    return url;
  }

  async get(pathname, params = {}) {
    const url = this.buildUrl(pathname, params);
    const response = await fetch(url);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      const error = new Error(payload.error?.message || `Meta HTTP ${response.status}`);
      error.code = payload.error?.code ? `META_${payload.error.code}` : "META_HTTP_ERROR";
      error.meta = payload.error || payload;
      throw error;
    }
    return payload;
  }

  async getAll(pathname, params = {}, maxPages = 100) {
    const rows = [];
    let next = this.buildUrl(pathname, { limit: 200, ...params }).toString();
    let pages = 0;
    while (next && pages < maxPages) {
      const payload = await this.get(next);
      rows.push(...(payload.data || []));
      next = payload.paging?.next || null;
      pages += 1;
    }
    return rows;
  }

  async discoverAssets() {
    let businesses = [];
    try {
      businesses = await this.getAll("me/businesses", {
        fields: "id,name,verification_status,created_time",
      });
    } catch (error) {
      if (!String(error.code || "").startsWith("META_")) throw error;
      businesses = [];
    }

    const accounts = await this.getAll("me/adaccounts", {
      fields: "id,account_id,name,account_status,currency,timezone_name,timezone_offset_hours_utc,business{id,name},disable_reason,amount_spent,balance",
    });

    return {
      businesses: businesses.map((item) => ({
        externalBusinessId: String(item.id),
        name: item.name || null,
        verificationStatus: item.verification_status || null,
        metadata: { createdTime: item.created_time || null },
      })),
      accounts: accounts.map((item) => ({
        externalAccountId: String(item.account_id || String(item.id || "").replace(/^act_/, "")),
        graphAccountId: String(item.id || ""),
        name: item.name || null,
        currencyCode: item.currency || null,
        timezone: item.timezone_name || null,
        statusCode: Number(item.account_status || 0),
        businessExternalId: item.business?.id ? String(item.business.id) : null,
        businessName: item.business?.name || null,
        metadata: {
          timezoneOffsetHoursUtc: item.timezone_offset_hours_utc ?? null,
          disableReason: item.disable_reason ?? null,
          amountSpent: item.amount_spent ?? null,
          balance: item.balance ?? null,
        },
      })).filter((item) => item.externalAccountId),
    };
  }

  async fetchSnapshot({ accountExternalId, startDate, endDate }) {
    const accountNode = `act_${String(accountExternalId).replace(/^act_/, "")}`;
    const timeRange = { since: startDate, until: endDate };

    const campaigns = await this.getAll(`${accountNode}/campaigns`, {
      fields: "id,name,status,effective_status,objective,buying_type,special_ad_categories,daily_budget,lifetime_budget,bid_strategy,start_time,stop_time",
    });
    const adsets = await this.getAll(`${accountNode}/adsets`, {
      fields: "id,name,status,effective_status,campaign_id,optimization_goal,billing_event,bid_strategy,daily_budget,lifetime_budget,start_time,end_time,targeting,promoted_object",
    });
    const ads = await this.getAll(`${accountNode}/ads`, {
      fields: "id,name,status,effective_status,campaign_id,adset_id,creative{id,name,title,body,thumbnail_url,image_url,object_story_spec,asset_feed_spec,call_to_action_type}",
    });

    const insightFields = [
      "date_start", "date_stop", "account_id", "account_name",
      "campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name",
      "impressions", "clicks", "unique_clicks", "spend", "reach", "frequency",
      "inline_link_clicks", "outbound_clicks", "actions", "action_values",
    ].join(",");

    const levelMap = [
      ["account", "account"],
      ["campaign", "campaign"],
      ["adset", "ad_group"],
      ["ad", "ad"],
    ];
    const metrics = [];
    const actionMetrics = [];
    for (const [level, entityType] of levelMap) {
      const rows = await this.getAll(`${accountNode}/insights`, {
        fields: insightFields,
        level,
        time_range: timeRange,
        time_increment: 1,
        action_report_time: "conversion",
        use_unified_attribution_setting: true,
      });
      for (const row of rows) {
        const parsed = parseInsightsRow(row, entityType, accountExternalId);
        if (parsed.metric.metric_date && parsed.metric.entity_external_id) metrics.push(parsed.metric);
        actionMetrics.push(...parsed.actionMetrics.filter((item) => item.metric_date && item.entity_external_id));
      }
    }

    const creativeMap = new Map();
    const normalizedAds = [];
    for (const item of ads) {
      const creative = item.creative || null;
      if (creative?.id) {
        creativeMap.set(String(creative.id), {
          external_creative_id: String(creative.id),
          name: creative.name || null,
          title: creative.title || null,
          body: creative.body || null,
          thumbnail_url: creative.thumbnail_url || null,
          image_url: creative.image_url || null,
          call_to_action_type: creative.call_to_action_type || null,
          metadata: {
            objectStorySpec: creative.object_story_spec || null,
            assetFeedSpec: creative.asset_feed_spec || null,
          },
        });
      }
      normalizedAds.push({
        external_ad_id: String(item.id),
        external_campaign_id: String(item.campaign_id || ""),
        external_ad_group_id: String(item.adset_id || ""),
        name: item.name || null,
        status: item.effective_status || item.status || null,
        ad_type: "META_AD",
        metadata: { configuredStatus: item.status || null, creativeId: creative?.id ? String(creative.id) : null },
      });
    }

    return {
      campaigns: campaigns.map((item) => ({
        external_campaign_id: String(item.id),
        name: item.name || null,
        status: item.effective_status || item.status || null,
        channel_type: item.objective || "META",
        bidding_strategy_type: item.bid_strategy || null,
        metadata: {
          configuredStatus: item.status || null,
          objective: item.objective || null,
          buyingType: item.buying_type || null,
          specialAdCategories: item.special_ad_categories || [],
          dailyBudget: item.daily_budget || null,
          lifetimeBudget: item.lifetime_budget || null,
          startTime: item.start_time || null,
          stopTime: item.stop_time || null,
        },
      })),
      adGroups: adsets.map((item) => ({
        external_ad_group_id: String(item.id),
        external_campaign_id: String(item.campaign_id || ""),
        name: item.name || null,
        status: item.effective_status || item.status || null,
        metadata: {
          configuredStatus: item.status || null,
          optimizationGoal: item.optimization_goal || null,
          billingEvent: item.billing_event || null,
          bidStrategy: item.bid_strategy || null,
          dailyBudget: item.daily_budget || null,
          lifetimeBudget: item.lifetime_budget || null,
          startTime: item.start_time || null,
          endTime: item.end_time || null,
          targeting: item.targeting || null,
          promotedObject: item.promoted_object || null,
        },
      })).filter((item) => item.external_ad_group_id && item.external_campaign_id),
      ads: normalizedAds.filter((item) => item.external_ad_id),
      creatives: [...creativeMap.values()],
      metrics,
      actionMetrics,
      counts: {
        campaigns: campaigns.length,
        adGroups: adsets.length,
        ads: normalizedAds.length,
        creatives: creativeMap.size,
        metrics: metrics.length,
        actionMetrics: actionMetrics.length,
      },
    };
  }
}

module.exports = { MetaGraphClient, parseInsightsRow, moneyToMicros };
