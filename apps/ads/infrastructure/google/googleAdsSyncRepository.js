"use strict";

const crypto = require("node:crypto");
const { withTenant } = require("../db/tenantDb");
const { decrypt, encrypt } = require("../security/tokenVault");

function attachIds(rows) {
  return (rows || []).map((row) => ({ id: crypto.randomUUID(), ...row }));
}

class GoogleAdsSyncRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async claimDueJob(workerId, lockMinutes) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `WITH candidate AS (
           SELECT id
           FROM ads_sync_jobs
           WHERE provider = 'google_ads'
             AND run_after <= now()
             AND (locked_at IS NULL OR locked_at < now() - ($2::text || ' minutes')::interval)
           ORDER BY run_after, created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE ads_sync_jobs j
         SET locked_at = now(), locked_by = $1, attempts = attempts + 1, updated_at = now()
         FROM candidate c
         WHERE j.id = c.id
         RETURNING j.*`,
        [workerId, String(lockMinutes)],
      );
      await client.query("COMMIT");
      return rows[0] || null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async loadSyncContext(job) {
    return withTenant(this.pool, job.tenant_id, async (client) => {
      const { rows } = await client.query(
        `SELECT a.id AS ad_account_id, a.workspace_id, a.connection_id, a.external_account_id,
                a.name, a.currency_code, a.timezone, a.manager, a.test_account,
                a.login_customer_id, a.sync_enabled, a.last_synced_at,
                c.status AS connection_status,
                cr.access_token_ciphertext, cr.refresh_token_ciphertext,
                cr.access_token_expires_at, cr.token_type, cr.scope
         FROM ads_ad_accounts a
         JOIN ads_provider_connections c ON c.id = a.connection_id
         JOIN ads_provider_credentials cr ON cr.connection_id = c.id
         WHERE a.tenant_id = $1 AND a.id = $2 AND a.provider = 'google_ads'
         LIMIT 1`,
        [job.tenant_id, job.ad_account_id],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        ...row,
        accessToken: decrypt(row.access_token_ciphertext),
        refreshToken: decrypt(row.refresh_token_ciphertext),
      };
    });
  }

  async updateAccessToken(tenantId, connectionId, token) {
    return withTenant(this.pool, tenantId, (client) => client.query(
      `UPDATE ads_provider_credentials
       SET access_token_ciphertext = $3,
           access_token_expires_at = $4,
           token_type = COALESCE($5, token_type),
           scope = COALESCE($6, scope),
           updated_at = now()
       WHERE tenant_id = $1 AND connection_id = $2`,
      [tenantId, connectionId, encrypt(token.accessToken), token.expiresAt, token.tokenType || null, token.scope || null],
    ));
  }

  async startRun(job, syncType) {
    const runId = crypto.randomUUID();
    await withTenant(this.pool, job.tenant_id, (client) => client.query(
      `INSERT INTO ads_sync_runs
         (id, tenant_id, workspace_id, provider, sync_type, status, started_at, cursor)
       VALUES ($1, $2, $3, 'google_ads', $4, 'running', now(), $5::jsonb)`,
      [runId, job.tenant_id, job.workspace_id, syncType, JSON.stringify({ adAccountId: job.ad_account_id, reason: job.reason })],
    ));
    return runId;
  }

  async finishRun(job, runId, { success, error, cursor, syncIntervalMinutes }) {
    await withTenant(this.pool, job.tenant_id, async (client) => {
      await client.query(
        `UPDATE ads_sync_runs
         SET status = $4, finished_at = now(), cursor = COALESCE($5::jsonb, cursor),
             error_code = $6, error_message = $7
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
        [
          job.tenant_id,
          job.workspace_id,
          runId,
          success ? "succeeded" : "failed",
          cursor ? JSON.stringify(cursor) : null,
          error?.code || null,
          error ? String(error.message || error).slice(0, 2000) : null,
        ],
      );
      await client.query(
        `UPDATE ads_ad_accounts
         SET last_synced_at = CASE WHEN $3 THEN now() ELSE last_synced_at END,
             last_sync_status = $4,
             last_sync_error = $5,
             updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [job.tenant_id, job.ad_account_id, success, success ? "succeeded" : "failed", error ? String(error.message || error).slice(0, 2000) : null],
      );
    });

    const retryMinutes = Math.min(60, Math.max(5, Number(job.attempts || 1) * 5));
    await this.pool.query(
      `UPDATE ads_sync_jobs
       SET locked_at = NULL,
           locked_by = NULL,
           last_error = $2,
           run_after = now() + ($3::text || ' minutes')::interval,
           attempts = CASE WHEN $4 THEN 0 ELSE attempts END,
           reason = CASE WHEN $4 THEN 'scheduled' ELSE reason END,
           updated_at = now()
       WHERE id = $1`,
      [
        job.id,
        error ? String(error.message || error).slice(0, 2000) : null,
        String(success ? syncIntervalMinutes : retryMinutes),
        success,
      ],
    );
  }

  async dropJob(jobId) {
    await this.pool.query("DELETE FROM ads_sync_jobs WHERE id = $1", [jobId]);
  }

  async persistSnapshot({ tenantId, workspaceId, adAccountId, data, window }) {
    return withTenant(this.pool, tenantId, async (client) => {
      await this.upsertCampaigns(client, tenantId, workspaceId, adAccountId, data.campaigns || []);
      await this.upsertAdGroups(client, tenantId, workspaceId, adAccountId, data.adGroups || []);
      await this.upsertAds(client, tenantId, workspaceId, adAccountId, data.ads || []);
      await this.upsertKeywords(client, tenantId, workspaceId, adAccountId, data.keywords || []);
      await this.upsertConversionActions(client, tenantId, workspaceId, adAccountId, data.conversionActions || []);
      await this.upsertMetrics(client, tenantId, workspaceId, adAccountId, data.metrics || []);
      await this.upsertSearchTerms(client, tenantId, workspaceId, adAccountId, data.searchTerms || []);
      await client.query(
        `INSERT INTO ads_sync_cursors
           (tenant_id, workspace_id, ad_account_id, provider, dataset, cursor, last_success_at, last_attempt_at)
         VALUES ($1, $2, $3, 'google_ads', 'core', $4::jsonb, now(), now())
         ON CONFLICT (tenant_id, ad_account_id, provider, dataset) DO UPDATE SET
           cursor = EXCLUDED.cursor,
           last_success_at = now(),
           last_attempt_at = now(),
           updated_at = now()`,
        [tenantId, workspaceId, adAccountId, JSON.stringify(window)],
      );
    });
  }

  async upsertCampaigns(client, tenantId, workspaceId, adAccountId, rows) {
    if (!rows.length) return;
    const payload = attachIds(rows);
    await client.query(
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($4::jsonb) AS x(
           id uuid, external_campaign_id text, name text, status text,
           channel_type text, bidding_strategy_type text, metadata jsonb
         )
       )
       INSERT INTO ads_campaigns
         (id, tenant_id, workspace_id, ad_account_id, provider, external_campaign_id,
          name, status, channel_type, bidding_strategy_type, metadata)
       SELECT id, $1, $2, $3, 'google_ads', external_campaign_id,
              name, status, channel_type, bidding_strategy_type, COALESCE(metadata, '{}'::jsonb)
       FROM input
       ON CONFLICT (tenant_id, ad_account_id, external_campaign_id) DO UPDATE SET
         name = EXCLUDED.name, status = EXCLUDED.status, channel_type = EXCLUDED.channel_type,
         bidding_strategy_type = EXCLUDED.bidding_strategy_type,
         metadata = ads_campaigns.metadata || EXCLUDED.metadata, updated_at = now()`,
      [tenantId, workspaceId, adAccountId, JSON.stringify(payload)],
    );
  }

  async upsertAdGroups(client, tenantId, workspaceId, adAccountId, rows) {
    if (!rows.length) return;
    const payload = attachIds(rows);
    await client.query(
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($4::jsonb) AS x(
           id uuid, external_ad_group_id text, external_campaign_id text,
           name text, status text, metadata jsonb
         )
       )
       INSERT INTO ads_ad_groups
         (id, tenant_id, workspace_id, ad_account_id, campaign_id, provider,
          external_ad_group_id, external_campaign_id, name, status, metadata)
       SELECT i.id, $1, $2, $3, c.id, 'google_ads', i.external_ad_group_id,
              i.external_campaign_id, i.name, i.status, COALESCE(i.metadata, '{}'::jsonb)
       FROM input i
       LEFT JOIN ads_campaigns c
         ON c.tenant_id = $1 AND c.ad_account_id = $3 AND c.external_campaign_id = i.external_campaign_id
       ON CONFLICT (tenant_id, ad_account_id, external_ad_group_id) DO UPDATE SET
         campaign_id = EXCLUDED.campaign_id, external_campaign_id = EXCLUDED.external_campaign_id,
         name = EXCLUDED.name, status = EXCLUDED.status,
         metadata = ads_ad_groups.metadata || EXCLUDED.metadata, updated_at = now()`,
      [tenantId, workspaceId, adAccountId, JSON.stringify(payload)],
    );
  }

  async upsertAds(client, tenantId, workspaceId, adAccountId, rows) {
    if (!rows.length) return;
    const payload = attachIds(rows);
    await client.query(
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($4::jsonb) AS x(
           id uuid, external_ad_id text, external_campaign_id text, external_ad_group_id text,
           name text, status text, ad_type text, metadata jsonb
         )
       )
       INSERT INTO ads_ads
         (id, tenant_id, workspace_id, ad_account_id, campaign_id, ad_group_id, provider,
          external_ad_id, external_campaign_id, external_ad_group_id, name, status, ad_type, metadata)
       SELECT i.id, $1, $2, $3, c.id, g.id, 'google_ads', i.external_ad_id,
              i.external_campaign_id, i.external_ad_group_id, i.name, i.status, i.ad_type,
              COALESCE(i.metadata, '{}'::jsonb)
       FROM input i
       LEFT JOIN ads_campaigns c
         ON c.tenant_id = $1 AND c.ad_account_id = $3 AND c.external_campaign_id = i.external_campaign_id
       LEFT JOIN ads_ad_groups g
         ON g.tenant_id = $1 AND g.ad_account_id = $3 AND g.external_ad_group_id = i.external_ad_group_id
       ON CONFLICT (tenant_id, ad_account_id, external_ad_id) DO UPDATE SET
         campaign_id = EXCLUDED.campaign_id, ad_group_id = EXCLUDED.ad_group_id,
         external_campaign_id = EXCLUDED.external_campaign_id,
         external_ad_group_id = EXCLUDED.external_ad_group_id,
         name = EXCLUDED.name, status = EXCLUDED.status, ad_type = EXCLUDED.ad_type,
         metadata = ads_ads.metadata || EXCLUDED.metadata, updated_at = now()`,
      [tenantId, workspaceId, adAccountId, JSON.stringify(payload)],
    );
  }

  async upsertKeywords(client, tenantId, workspaceId, adAccountId, rows) {
    if (!rows.length) return;
    const payload = attachIds(rows);
    await client.query(
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($4::jsonb) AS x(
           id uuid, external_criterion_id text, external_campaign_id text, external_ad_group_id text,
           keyword_text text, match_type text, status text, negative boolean, metadata jsonb
         )
       )
       INSERT INTO ads_google_keywords
         (id, tenant_id, workspace_id, ad_account_id, campaign_id, ad_group_id,
          external_criterion_id, external_campaign_id, external_ad_group_id,
          keyword_text, match_type, status, negative, metadata)
       SELECT i.id, $1, $2, $3, c.id, g.id, i.external_criterion_id,
              i.external_campaign_id, i.external_ad_group_id, i.keyword_text,
              i.match_type, i.status, COALESCE(i.negative, false), COALESCE(i.metadata, '{}'::jsonb)
       FROM input i
       LEFT JOIN ads_campaigns c
         ON c.tenant_id = $1 AND c.ad_account_id = $3 AND c.external_campaign_id = i.external_campaign_id
       LEFT JOIN ads_ad_groups g
         ON g.tenant_id = $1 AND g.ad_account_id = $3 AND g.external_ad_group_id = i.external_ad_group_id
       ON CONFLICT (tenant_id, ad_account_id, external_criterion_id) DO UPDATE SET
         campaign_id = EXCLUDED.campaign_id, ad_group_id = EXCLUDED.ad_group_id,
         external_campaign_id = EXCLUDED.external_campaign_id,
         external_ad_group_id = EXCLUDED.external_ad_group_id,
         keyword_text = EXCLUDED.keyword_text, match_type = EXCLUDED.match_type,
         status = EXCLUDED.status, negative = EXCLUDED.negative,
         metadata = ads_google_keywords.metadata || EXCLUDED.metadata, updated_at = now()`,
      [tenantId, workspaceId, adAccountId, JSON.stringify(payload)],
    );
  }

  async upsertConversionActions(client, tenantId, workspaceId, adAccountId, rows) {
    if (!rows.length) return;
    const payload = attachIds(rows);
    await client.query(
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($4::jsonb) AS x(
           id uuid, external_conversion_action_id text, name text, status text,
           action_type text, category text, primary_for_goal boolean, metadata jsonb
         )
       )
       INSERT INTO ads_conversion_actions
         (id, tenant_id, workspace_id, ad_account_id, provider, external_conversion_action_id,
          name, status, action_type, category, primary_for_goal, metadata)
       SELECT id, $1, $2, $3, 'google_ads', external_conversion_action_id,
              name, status, action_type, category, primary_for_goal, COALESCE(metadata, '{}'::jsonb)
       FROM input
       ON CONFLICT (tenant_id, ad_account_id, external_conversion_action_id) DO UPDATE SET
         name = EXCLUDED.name, status = EXCLUDED.status, action_type = EXCLUDED.action_type,
         category = EXCLUDED.category, primary_for_goal = EXCLUDED.primary_for_goal,
         metadata = ads_conversion_actions.metadata || EXCLUDED.metadata, updated_at = now()`,
      [tenantId, workspaceId, adAccountId, JSON.stringify(payload)],
    );
  }

  async upsertMetrics(client, tenantId, workspaceId, adAccountId, rows) {
    if (!rows.length) return;
    await client.query(
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($4::jsonb) AS x(
           metric_date date, entity_type text, entity_external_id text,
           campaign_external_id text, ad_group_external_id text,
           impressions bigint, clicks bigint, cost_micros bigint,
           conversions numeric, conversion_value numeric,
           all_conversions numeric, all_conversion_value numeric, metadata jsonb
         )
       )
       INSERT INTO ads_metrics_daily
         (tenant_id, workspace_id, ad_account_id, provider, metric_date, entity_type,
          entity_external_id, campaign_external_id, ad_group_external_id,
          impressions, clicks, cost_micros, conversions, conversion_value,
          all_conversions, all_conversion_value, metadata)
       SELECT $1, $2, $3, 'google_ads', metric_date, entity_type, entity_external_id,
              campaign_external_id, ad_group_external_id, COALESCE(impressions,0),
              COALESCE(clicks,0), COALESCE(cost_micros,0), COALESCE(conversions,0),
              COALESCE(conversion_value,0), COALESCE(all_conversions,0),
              COALESCE(all_conversion_value,0), COALESCE(metadata, '{}'::jsonb)
       FROM input
       ON CONFLICT (tenant_id, ad_account_id, metric_date, entity_type, entity_external_id) DO UPDATE SET
         campaign_external_id = EXCLUDED.campaign_external_id,
         ad_group_external_id = EXCLUDED.ad_group_external_id,
         impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
         cost_micros = EXCLUDED.cost_micros, conversions = EXCLUDED.conversions,
         conversion_value = EXCLUDED.conversion_value,
         all_conversions = EXCLUDED.all_conversions,
         all_conversion_value = EXCLUDED.all_conversion_value,
         metadata = ads_metrics_daily.metadata || EXCLUDED.metadata,
         updated_at = now()`,
      [tenantId, workspaceId, adAccountId, JSON.stringify(rows)],
    );
  }

  async upsertSearchTerms(client, tenantId, workspaceId, adAccountId, rows) {
    if (!rows.length) return;
    await client.query(
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($4::jsonb) AS x(
           metric_date date, external_campaign_id text, external_ad_group_id text,
           search_term text, search_term_status text, impressions bigint, clicks bigint,
           cost_micros bigint, conversions numeric, conversion_value numeric, metadata jsonb
         )
       )
       INSERT INTO ads_google_search_terms_daily
         (tenant_id, workspace_id, ad_account_id, metric_date, external_campaign_id,
          external_ad_group_id, search_term, search_term_status, impressions, clicks,
          cost_micros, conversions, conversion_value, metadata)
       SELECT $1, $2, $3, metric_date, external_campaign_id, external_ad_group_id,
              search_term, search_term_status, COALESCE(impressions,0), COALESCE(clicks,0),
              COALESCE(cost_micros,0), COALESCE(conversions,0), COALESCE(conversion_value,0),
              COALESCE(metadata, '{}'::jsonb)
       FROM input
       ON CONFLICT (tenant_id, ad_account_id, metric_date, external_campaign_id,
                    external_ad_group_id, search_term) DO UPDATE SET
         search_term_status = EXCLUDED.search_term_status,
         impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
         cost_micros = EXCLUDED.cost_micros, conversions = EXCLUDED.conversions,
         conversion_value = EXCLUDED.conversion_value,
         metadata = ads_google_search_terms_daily.metadata || EXCLUDED.metadata,
         updated_at = now()`,
      [tenantId, workspaceId, adAccountId, JSON.stringify(rows)],
    );
  }
}

module.exports = { GoogleAdsSyncRepository };
