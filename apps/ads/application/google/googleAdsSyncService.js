"use strict";

const { env } = require("../../config/env");
const { GoogleAdsClient } = require("../../infrastructure/google/googleAdsClient");
const { ensureValidAccessToken } = require("./googleTokenManager");

function yyyyMmDd(date) {
  return date.toISOString().slice(0, 10);
}

function dateWindow(days) {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - Math.max(1, Number(days)) + 1);
  return { startDate: yyyyMmDd(start), endDate: yyyyMmDd(end), days: Number(days) };
}

function str(value, fallback = "0") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function metricsFrom(row) {
  const metrics = row.metrics || {};
  return {
    impressions: str(metrics.impressions),
    clicks: str(metrics.clicks),
    cost_micros: str(metrics.costMicros),
    conversions: str(metrics.conversions),
    conversion_value: str(metrics.conversionsValue),
    all_conversions: str(metrics.allConversions),
    all_conversion_value: str(metrics.allConversionsValue),
  };
}

function dedupeBy(rows, key) {
  const map = new Map();
  for (const row of rows) map.set(key(row), row);
  return [...map.values()];
}

class GoogleAdsSyncService {
  constructor(repository) {
    this.repository = repository;
  }

  async syncJob(job) {
    const context = await this.repository.loadSyncContext(job);
    if (!context || !context.sync_enabled || context.connection_status !== "active") {
      await this.repository.dropJob(job.id);
      return { skipped: true, reason: "account_or_connection_inactive" };
    }
    if (context.manager) {
      await this.repository.dropJob(job.id);
      return { skipped: true, reason: "manager_accounts_are_not_sync_targets" };
    }

    const initial = !context.last_synced_at;
    const window = dateWindow(initial ? env.googleInitialLookbackDays : env.googleRecentLookbackDays);
    const runId = await this.repository.startRun(job, initial ? "initial_backfill" : "recent_refresh");

    try {
      const accessToken = await ensureValidAccessToken(
        this.repository,
        job.tenant_id,
        context.connection_id,
        context,
      );
      const client = new GoogleAdsClient({ accessToken });
      const data = await this.fetchAccountSnapshot(client, context, window);
      await this.repository.persistSnapshot({
        tenantId: job.tenant_id,
        workspaceId: context.workspace_id,
        adAccountId: context.ad_account_id,
        data,
        window,
      });
      await this.repository.finishRun(job, runId, {
        success: true,
        cursor: {
          startDate: window.startDate,
          endDate: window.endDate,
          campaigns: data.campaigns.length,
          adGroups: data.adGroups.length,
          ads: data.ads.length,
          keywords: data.keywords.length,
          searchTerms: data.searchTerms.length,
          metrics: data.metrics.length,
        },
        syncIntervalMinutes: env.googleSyncIntervalMinutes,
      });
      return { success: true, window, counts: data.counts };
    } catch (error) {
      await this.repository.finishRun(job, runId, {
        success: false,
        error,
        cursor: { startDate: window.startDate, endDate: window.endDate },
        syncIntervalMinutes: env.googleSyncIntervalMinutes,
      });
      throw error;
    }
  }

  async fetchAccountSnapshot(client, context, window) {
    const accountId = context.external_account_id;
    const loginCustomerId = context.login_customer_id || null;
    const dateFilter = `segments.date BETWEEN '${window.startDate}' AND '${window.endDate}'`;
    const opts = { loginCustomerId };

    // Keep provider pressure predictable on a single VPS. The worker already
    // serializes accounts; provider queries are intentionally executed in
    // sequence instead of bursting several Google Ads searches at once.
    const accountRows = await client.searchAll(
      accountId,
      `SELECT segments.date, customer.id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.all_conversions, metrics.all_conversions_value FROM customer WHERE ${dateFilter}`,
      opts,
    );
    const campaignRows = await client.searchAll(
      accountId,
      `SELECT segments.date, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.all_conversions, metrics.all_conversions_value FROM campaign WHERE ${dateFilter}`,
      opts,
    );
    const adGroupRows = await client.searchAll(
      accountId,
      `SELECT segments.date, campaign.id, ad_group.id, ad_group.name, ad_group.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.all_conversions, metrics.all_conversions_value FROM ad_group WHERE ${dateFilter}`,
      opts,
    );
    const adRows = await client.searchAll(
      accountId,
      `SELECT campaign.id, ad_group.id, ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.ad.type FROM ad_group_ad`,
      opts,
    );
    const keywordRows = await client.searchAll(
      accountId,
      `SELECT segments.date, campaign.id, ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.negative, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.all_conversions, metrics.all_conversions_value FROM keyword_view WHERE ${dateFilter}`,
      opts,
    );
    const searchTermRows = await client.searchAll(
      accountId,
      `SELECT segments.date, campaign.id, ad_group.id, search_term_view.search_term, search_term_view.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM search_term_view WHERE ${dateFilter}`,
      opts,
    );
    const conversionRows = await client.searchAll(
      accountId,
      `SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type, conversion_action.category, conversion_action.primary_for_goal FROM conversion_action`,
      opts,
    );

    const campaigns = dedupeBy(campaignRows.map((row) => ({
      external_campaign_id: str(row.campaign?.id, ""),
      name: row.campaign?.name || null,
      status: row.campaign?.status || null,
      channel_type: row.campaign?.advertisingChannelType || null,
      bidding_strategy_type: row.campaign?.biddingStrategyType || null,
      metadata: {},
    })).filter((row) => row.external_campaign_id), (row) => row.external_campaign_id);

    const adGroups = dedupeBy(adGroupRows.map((row) => ({
      external_ad_group_id: str(row.adGroup?.id, ""),
      external_campaign_id: str(row.campaign?.id, ""),
      name: row.adGroup?.name || null,
      status: row.adGroup?.status || null,
      metadata: {},
    })).filter((row) => row.external_ad_group_id && row.external_campaign_id), (row) => row.external_ad_group_id);

    const ads = dedupeBy(adRows.map((row) => ({
      external_ad_id: str(row.adGroupAd?.ad?.id, ""),
      external_campaign_id: str(row.campaign?.id, ""),
      external_ad_group_id: str(row.adGroup?.id, ""),
      name: null,
      status: row.adGroupAd?.status || null,
      ad_type: row.adGroupAd?.ad?.type || null,
      metadata: {},
    })).filter((row) => row.external_ad_id), (row) => row.external_ad_id);

    const keywords = dedupeBy(keywordRows.map((row) => ({
      external_criterion_id: str(row.adGroupCriterion?.criterionId, ""),
      external_campaign_id: str(row.campaign?.id, ""),
      external_ad_group_id: str(row.adGroup?.id, ""),
      keyword_text: row.adGroupCriterion?.keyword?.text || "",
      match_type: row.adGroupCriterion?.keyword?.matchType || null,
      status: row.adGroupCriterion?.status || null,
      negative: Boolean(row.adGroupCriterion?.negative),
      metadata: {},
    })).filter((row) => row.external_criterion_id && row.keyword_text), (row) => row.external_criterion_id);

    const conversionActions = dedupeBy(conversionRows.map((row) => ({
      external_conversion_action_id: str(row.conversionAction?.id, ""),
      name: row.conversionAction?.name || null,
      status: row.conversionAction?.status || null,
      action_type: row.conversionAction?.type || null,
      category: row.conversionAction?.category || null,
      primary_for_goal: row.conversionAction?.primaryForGoal ?? null,
      metadata: {},
    })).filter((row) => row.external_conversion_action_id), (row) => row.external_conversion_action_id);

    const metrics = [];
    for (const row of accountRows) {
      metrics.push({
        metric_date: row.segments?.date,
        entity_type: "account",
        entity_external_id: accountId,
        campaign_external_id: null,
        ad_group_external_id: null,
        ...metricsFrom(row),
        metadata: {},
      });
    }
    for (const row of campaignRows) {
      metrics.push({
        metric_date: row.segments?.date,
        entity_type: "campaign",
        entity_external_id: str(row.campaign?.id, ""),
        campaign_external_id: str(row.campaign?.id, ""),
        ad_group_external_id: null,
        ...metricsFrom(row),
        metadata: {},
      });
    }
    for (const row of adGroupRows) {
      metrics.push({
        metric_date: row.segments?.date,
        entity_type: "ad_group",
        entity_external_id: str(row.adGroup?.id, ""),
        campaign_external_id: str(row.campaign?.id, ""),
        ad_group_external_id: str(row.adGroup?.id, ""),
        ...metricsFrom(row),
        metadata: {},
      });
    }
    for (const row of keywordRows) {
      metrics.push({
        metric_date: row.segments?.date,
        entity_type: "keyword",
        entity_external_id: str(row.adGroupCriterion?.criterionId, ""),
        campaign_external_id: str(row.campaign?.id, ""),
        ad_group_external_id: str(row.adGroup?.id, ""),
        ...metricsFrom(row),
        metadata: {},
      });
    }

    const searchTerms = searchTermRows.map((row) => ({
      metric_date: row.segments?.date,
      external_campaign_id: str(row.campaign?.id, ""),
      external_ad_group_id: str(row.adGroup?.id, ""),
      search_term: row.searchTermView?.searchTerm || "",
      search_term_status: row.searchTermView?.status || null,
      impressions: str(row.metrics?.impressions),
      clicks: str(row.metrics?.clicks),
      cost_micros: str(row.metrics?.costMicros),
      conversions: str(row.metrics?.conversions),
      conversion_value: str(row.metrics?.conversionsValue),
      metadata: {},
    })).filter((row) => row.metric_date && row.search_term);

    return {
      campaigns,
      adGroups,
      ads,
      keywords,
      conversionActions,
      metrics: metrics.filter((row) => row.metric_date && row.entity_external_id),
      searchTerms,
      counts: {
        campaigns: campaigns.length,
        adGroups: adGroups.length,
        ads: ads.length,
        keywords: keywords.length,
        searchTerms: searchTerms.length,
        conversionActions: conversionActions.length,
        metrics: metrics.length,
      },
    };
  }
}

module.exports = { GoogleAdsSyncService, dateWindow, metricsFrom };
