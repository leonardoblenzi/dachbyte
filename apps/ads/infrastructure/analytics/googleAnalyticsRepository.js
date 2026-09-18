"use strict";

const { withTenant } = require("../db/tenantDb");

class GoogleAnalyticsRepository {
  constructor(pool) { this.pool = pool; }

  async listAccounts(tenantId, workspaceId) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, external_account_id, name, currency_code, timezone, status,
                sync_enabled, last_synced_at, last_sync_status, last_sync_error
         FROM ads_ad_accounts
         WHERE tenant_id = $1 AND workspace_id = $2
           AND provider = 'google_ads' AND manager = false AND sync_enabled = true
         ORDER BY last_synced_at DESC NULLS LAST, name NULLS LAST, external_account_id`,
        [tenantId, workspaceId],
      );
      return rows;
    });
  }

  async resolveAccount(tenantId, workspaceId, accountId) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, external_account_id, name, currency_code, timezone, status,
                sync_enabled, last_synced_at, last_sync_status, last_sync_error
         FROM ads_ad_accounts
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
           AND provider = 'google_ads' AND manager = false AND sync_enabled = true
         LIMIT 1`,
        [tenantId, workspaceId, accountId],
      );
      return rows[0] || null;
    });
  }

  async getLatestMetricDate(tenantId, accountId) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT max(metric_date)::text AS latest_date
         FROM ads_metrics_daily
         WHERE tenant_id = $1 AND ad_account_id = $2
           AND provider = 'google_ads' AND entity_type = 'account'`,
        [tenantId, accountId],
      );
      return rows[0]?.latest_date || null;
    });
  }

  async getSummary(tenantId, accountId, startDate, endDate) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT
           COALESCE(sum(impressions), 0)::text AS impressions,
           COALESCE(sum(clicks), 0)::text AS clicks,
           COALESCE(sum(cost_micros), 0)::text AS cost_micros,
           COALESCE(sum(conversions), 0)::text AS conversions,
           COALESCE(sum(conversion_value), 0)::text AS conversion_value,
           COALESCE(sum(all_conversions), 0)::text AS all_conversions,
           COALESCE(sum(all_conversion_value), 0)::text AS all_conversion_value
         FROM ads_metrics_daily
         WHERE tenant_id = $1 AND ad_account_id = $2
           AND provider = 'google_ads' AND entity_type = 'account'
           AND metric_date BETWEEN $3::date AND $4::date`,
        [tenantId, accountId, startDate, endDate],
      );
      return rows[0];
    });
  }

  async getDailySeries(tenantId, accountId, startDate, endDate) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT metric_date::text AS metric_date,
                impressions::text, clicks::text, cost_micros::text,
                conversions::text, conversion_value::text,
                all_conversions::text, all_conversion_value::text
         FROM ads_metrics_daily
         WHERE tenant_id = $1 AND ad_account_id = $2
           AND provider = 'google_ads' AND entity_type = 'account'
           AND metric_date BETWEEN $3::date AND $4::date
         ORDER BY metric_date ASC`,
        [tenantId, accountId, startDate, endDate],
      );
      return rows;
    });
  }

  async getCampaigns(tenantId, accountId, startDate, endDate, limit = 100) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT m.entity_external_id AS campaign_id,
                COALESCE(c.name, m.entity_external_id) AS name,
                c.status, c.channel_type, c.bidding_strategy_type,
                COALESCE(sum(m.impressions), 0)::text AS impressions,
                COALESCE(sum(m.clicks), 0)::text AS clicks,
                COALESCE(sum(m.cost_micros), 0)::text AS cost_micros,
                COALESCE(sum(m.conversions), 0)::text AS conversions,
                COALESCE(sum(m.conversion_value), 0)::text AS conversion_value
         FROM ads_metrics_daily m
         LEFT JOIN ads_campaigns c
           ON c.tenant_id = m.tenant_id AND c.ad_account_id = m.ad_account_id
          AND c.external_campaign_id = m.entity_external_id
         WHERE m.tenant_id = $1 AND m.ad_account_id = $2
           AND m.provider = 'google_ads' AND m.entity_type = 'campaign'
           AND m.metric_date BETWEEN $3::date AND $4::date
         GROUP BY m.entity_external_id, c.name, c.status, c.channel_type, c.bidding_strategy_type
         ORDER BY sum(m.cost_micros) DESC, sum(m.conversions) DESC
         LIMIT $5`,
        [tenantId, accountId, startDate, endDate, limit],
      );
      return rows;
    });
  }

  async getKeywords(tenantId, accountId, startDate, endDate, limit = 100) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT m.entity_external_id AS criterion_id,
                COALESCE(k.keyword_text, m.entity_external_id) AS keyword_text,
                k.match_type, k.status, k.negative,
                COALESCE(c.name, m.campaign_external_id) AS campaign_name,
                COALESCE(g.name, m.ad_group_external_id) AS ad_group_name,
                COALESCE(sum(m.impressions), 0)::text AS impressions,
                COALESCE(sum(m.clicks), 0)::text AS clicks,
                COALESCE(sum(m.cost_micros), 0)::text AS cost_micros,
                COALESCE(sum(m.conversions), 0)::text AS conversions,
                COALESCE(sum(m.conversion_value), 0)::text AS conversion_value
         FROM ads_metrics_daily m
         LEFT JOIN ads_google_keywords k
           ON k.tenant_id = m.tenant_id AND k.ad_account_id = m.ad_account_id
          AND k.external_criterion_id = m.entity_external_id
         LEFT JOIN ads_campaigns c
           ON c.tenant_id = m.tenant_id AND c.ad_account_id = m.ad_account_id
          AND c.external_campaign_id = m.campaign_external_id
         LEFT JOIN ads_ad_groups g
           ON g.tenant_id = m.tenant_id AND g.ad_account_id = m.ad_account_id
          AND g.external_ad_group_id = m.ad_group_external_id
         WHERE m.tenant_id = $1 AND m.ad_account_id = $2
           AND m.provider = 'google_ads' AND m.entity_type = 'keyword'
           AND m.metric_date BETWEEN $3::date AND $4::date
         GROUP BY m.entity_external_id, k.keyword_text, k.match_type, k.status, k.negative,
                  c.name, m.campaign_external_id, g.name, m.ad_group_external_id
         ORDER BY sum(m.cost_micros) DESC, sum(m.conversions) DESC
         LIMIT $5`,
        [tenantId, accountId, startDate, endDate, limit],
      );
      return rows;
    });
  }

  async getSearchTerms(tenantId, accountId, startDate, endDate, limit = 100) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT s.search_term, s.search_term_status, s.external_campaign_id,
                COALESCE(c.name, s.external_campaign_id) AS campaign_name,
                s.external_ad_group_id,
                COALESCE(g.name, s.external_ad_group_id) AS ad_group_name,
                COALESCE(sum(s.impressions), 0)::text AS impressions,
                COALESCE(sum(s.clicks), 0)::text AS clicks,
                COALESCE(sum(s.cost_micros), 0)::text AS cost_micros,
                COALESCE(sum(s.conversions), 0)::text AS conversions,
                COALESCE(sum(s.conversion_value), 0)::text AS conversion_value
         FROM ads_google_search_terms_daily s
         LEFT JOIN ads_campaigns c
           ON c.tenant_id = s.tenant_id AND c.ad_account_id = s.ad_account_id
          AND c.external_campaign_id = s.external_campaign_id
         LEFT JOIN ads_ad_groups g
           ON g.tenant_id = s.tenant_id AND g.ad_account_id = s.ad_account_id
          AND g.external_ad_group_id = s.external_ad_group_id
         WHERE s.tenant_id = $1 AND s.ad_account_id = $2
           AND s.metric_date BETWEEN $3::date AND $4::date
         GROUP BY s.search_term, s.search_term_status, s.external_campaign_id, c.name,
                  s.external_ad_group_id, g.name
         ORDER BY sum(s.cost_micros) DESC, sum(s.conversions) DESC
         LIMIT $5`,
        [tenantId, accountId, startDate, endDate, limit],
      );
      return rows;
    });
  }

  async getConversionActions(tenantId, accountId) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT external_conversion_action_id AS id, name, status, action_type, category, primary_for_goal
         FROM ads_conversion_actions
         WHERE tenant_id = $1 AND ad_account_id = $2 AND provider = 'google_ads'
         ORDER BY primary_for_goal DESC NULLS LAST, name NULLS LAST`,
        [tenantId, accountId],
      );
      return rows;
    });
  }
}

module.exports = { GoogleAnalyticsRepository };
