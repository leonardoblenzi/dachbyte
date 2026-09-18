"use strict";

const crypto = require("node:crypto");
const { withTenant } = require("../db/tenantDb");

class MultichannelAnalyticsRepository {
  constructor(pool) { this.pool = pool; }

  async listAccounts(tenantId, workspaceId) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, provider, external_account_id, name, currency_code, timezone,
                sync_enabled, last_synced_at, last_sync_status, last_sync_error
         FROM ads_ad_accounts
         WHERE tenant_id = $1 AND workspace_id = $2
           AND sync_enabled = true AND COALESCE(manager, false) = false
         ORDER BY provider, name NULLS LAST, external_account_id`,
        [tenantId, workspaceId],
      );
      return rows;
    });
  }

  async getLatestMetricDates(tenantId, workspaceId) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT a.provider, max(m.metric_date)::text AS latest_date
         FROM ads_ad_accounts a
         JOIN ads_metrics_daily m
           ON m.tenant_id = a.tenant_id AND m.ad_account_id = a.id
          AND m.provider = a.provider AND m.entity_type = 'account'
         WHERE a.tenant_id = $1 AND a.workspace_id = $2
           AND a.sync_enabled = true AND COALESCE(a.manager, false) = false
         GROUP BY a.provider`,
        [tenantId, workspaceId],
      );
      return Object.fromEntries(rows.map((row) => [row.provider, row.latest_date]));
    });
  }

  async getProviderSummary(tenantId, workspaceId, provider, startDate, endDate) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT
           COALESCE(sum(m.impressions), 0)::text AS impressions,
           COALESCE(sum(m.clicks), 0)::text AS clicks,
           COALESCE(sum(m.cost_micros), 0)::text AS cost_micros,
           COALESCE(sum(m.conversions), 0)::text AS conversions,
           COALESCE(sum(m.conversion_value), 0)::text AS conversion_value,
           COALESCE(sum(m.reach), 0)::text AS reach,
           CASE WHEN sum(m.impressions) > 0
             THEN (sum(m.reach)::numeric / NULLIF(sum(m.impressions),0))::text
             ELSE '0' END AS reach_ratio
         FROM ads_metrics_daily m
         JOIN ads_ad_accounts a
           ON a.tenant_id = m.tenant_id AND a.id = m.ad_account_id
         WHERE m.tenant_id = $1 AND a.workspace_id = $2
           AND m.provider = $3 AND a.provider = $3
           AND a.sync_enabled = true AND COALESCE(a.manager, false) = false
           AND m.entity_type = 'account'
           AND m.metric_date BETWEEN $4::date AND $5::date`,
        [tenantId, workspaceId, provider, startDate, endDate],
      );
      return rows[0];
    });
  }

  async getMetaPrimaryConversions(tenantId, workspaceId, startDate, endDate) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT
           COALESCE(sum(am.action_count), 0)::text AS conversions,
           COALESCE(sum(am.action_value), 0)::text AS conversion_value,
           count(DISTINCT map.ad_account_id)::int AS mapped_accounts
         FROM ads_conversion_mappings map
         JOIN ads_ad_accounts a
           ON a.tenant_id = map.tenant_id AND a.id = map.ad_account_id
          AND a.workspace_id = map.workspace_id
         LEFT JOIN ads_meta_action_metrics_daily am
           ON am.tenant_id = map.tenant_id
          AND am.ad_account_id = map.ad_account_id
          AND am.action_type = map.source_key
          AND am.entity_type = 'account'
          AND am.metric_date BETWEEN $3::date AND $4::date
         WHERE map.tenant_id = $1 AND map.workspace_id = $2
           AND map.provider = 'meta_ads' AND map.is_primary = true AND map.is_active = true
           AND a.sync_enabled = true`,
        [tenantId, workspaceId, startDate, endDate],
      );
      return rows[0];
    });
  }

  async getMetaFrequencySummary(tenantId, workspaceId, startDate, endDate) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT
           COALESCE(sum(m.impressions), 0)::text AS impressions,
           COALESCE(sum(m.reach), 0)::text AS reach,
           CASE WHEN sum(m.reach) > 0
             THEN (sum(m.impressions)::numeric / NULLIF(sum(m.reach),0))::text
             ELSE '0' END AS frequency
         FROM ads_metrics_daily m
         JOIN ads_ad_accounts a
           ON a.tenant_id = m.tenant_id AND a.id = m.ad_account_id
         WHERE m.tenant_id = $1 AND a.workspace_id = $2
           AND m.provider = 'meta_ads' AND a.provider = 'meta_ads'
           AND a.sync_enabled = true AND m.entity_type = 'account'
           AND m.metric_date BETWEEN $3::date AND $4::date`,
        [tenantId, workspaceId, startDate, endDate],
      );
      return rows[0];
    });
  }

  async getTargets(tenantId, workspaceId) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT workspace_id, currency_code, monthly_budget::text, target_cpa::text,
                target_roas::text, average_ticket::text, gross_margin_percent::text,
                notes, updated_at
         FROM ads_business_targets
         WHERE tenant_id = $1 AND workspace_id = $2 LIMIT 1`,
        [tenantId, workspaceId],
      );
      return rows[0] || null;
    });
  }

  async upsertTargets(tenantId, workspaceId, userId, input) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO ads_business_targets
           (workspace_id, tenant_id, currency_code, monthly_budget, target_cpa, target_roas,
            average_ticket, gross_margin_percent, notes, updated_by_user_id, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
         ON CONFLICT (workspace_id) DO UPDATE SET
           currency_code = EXCLUDED.currency_code,
           monthly_budget = EXCLUDED.monthly_budget,
           target_cpa = EXCLUDED.target_cpa,
           target_roas = EXCLUDED.target_roas,
           average_ticket = EXCLUDED.average_ticket,
           gross_margin_percent = EXCLUDED.gross_margin_percent,
           notes = EXCLUDED.notes,
           updated_by_user_id = EXCLUDED.updated_by_user_id,
           updated_at = now()
         RETURNING workspace_id, currency_code, monthly_budget::text, target_cpa::text,
                   target_roas::text, average_ticket::text, gross_margin_percent::text,
                   notes, updated_at`,
        [workspaceId, tenantId, input.currencyCode, input.monthlyBudget, input.targetCpa,
          input.targetRoas, input.averageTicket, input.grossMarginPercent, input.notes, userId],
      );
      return rows[0];
    });
  }

  async listMetaActionTypes(tenantId, workspaceId) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT a.id AS ad_account_id, a.external_account_id, a.name AS account_name,
                am.action_type,
                COALESCE(sum(am.action_count),0)::text AS action_count,
                COALESCE(sum(am.action_value),0)::text AS action_value,
                map.semantic_type, map.is_primary, map.is_active
         FROM ads_ad_accounts a
         JOIN ads_meta_action_metrics_daily am
           ON am.tenant_id = a.tenant_id AND am.ad_account_id = a.id AND am.entity_type = 'account'
         LEFT JOIN ads_conversion_mappings map
           ON map.tenant_id = a.tenant_id AND map.ad_account_id = a.id
          AND map.provider = 'meta_ads' AND map.source_key = am.action_type
         WHERE a.tenant_id = $1 AND a.workspace_id = $2
           AND a.provider = 'meta_ads' AND a.sync_enabled = true
         GROUP BY a.id, a.external_account_id, a.name, am.action_type,
                  map.semantic_type, map.is_primary, map.is_active
         ORDER BY a.name NULLS LAST, sum(am.action_count) DESC, am.action_type`,
        [tenantId, workspaceId],
      );
      return rows;
    });
  }

  async setMetaPrimaryConversion(tenantId, workspaceId, accountId, input) {
    return withTenant(this.pool, tenantId, async (client) => {
      const check = await client.query(
        `SELECT id FROM ads_ad_accounts
         WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND provider='meta_ads' AND sync_enabled=true`,
        [tenantId, workspaceId, accountId],
      );
      if (!check.rowCount) return null;

      await client.query(
        `UPDATE ads_conversion_mappings SET is_primary=false, updated_at=now()
         WHERE tenant_id=$1 AND workspace_id=$2 AND ad_account_id=$3 AND provider='meta_ads'`,
        [tenantId, workspaceId, accountId],
      );

      if (!input.sourceKey) return { cleared: true };
      const { rows } = await client.query(
        `INSERT INTO ads_conversion_mappings
           (id, tenant_id, workspace_id, ad_account_id, provider, source_key, label,
            semantic_type, is_primary, is_active, updated_at)
         VALUES ($1,$2,$3,$4,'meta_ads',$5,$6,$7,true,true,now())
         ON CONFLICT (tenant_id, ad_account_id, source_key) DO UPDATE SET
           label=EXCLUDED.label, semantic_type=EXCLUDED.semantic_type,
           is_primary=true, is_active=true, updated_at=now()
         RETURNING id, ad_account_id, source_key, label, semantic_type, is_primary, is_active, updated_at`,
        [crypto.randomUUID(), tenantId, workspaceId, accountId, input.sourceKey, input.label, input.semanticType],
      );
      return rows[0];
    });
  }

  async getGoogleZeroConversionSearchTerms(tenantId, workspaceId, startDate, endDate, limit = 10) {
    return withTenant(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT s.search_term,
                COALESCE(c.name, s.external_campaign_id) AS campaign_name,
                COALESCE(sum(s.cost_micros),0)::text AS cost_micros,
                COALESCE(sum(s.clicks),0)::text AS clicks,
                COALESCE(sum(s.conversions),0)::text AS conversions
         FROM ads_google_search_terms_daily s
         JOIN ads_ad_accounts a ON a.tenant_id=s.tenant_id AND a.id=s.ad_account_id
         LEFT JOIN ads_campaigns c
           ON c.tenant_id=s.tenant_id AND c.ad_account_id=s.ad_account_id
          AND c.external_campaign_id=s.external_campaign_id
         WHERE s.tenant_id=$1 AND a.workspace_id=$2 AND a.sync_enabled=true
           AND s.metric_date BETWEEN $3::date AND $4::date
         GROUP BY s.search_term, c.name, s.external_campaign_id
         HAVING sum(s.cost_micros) > 0 AND sum(s.conversions) = 0
         ORDER BY sum(s.cost_micros) DESC
         LIMIT $5`,
        [tenantId, workspaceId, startDate, endDate, limit],
      );
      return rows;
    });
  }
}

module.exports = { MultichannelAnalyticsRepository };
