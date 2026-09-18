"use strict";

const { env } = require("../../config/env");
const { MetaGraphClient } = require("../../infrastructure/meta/metaGraphClient");
const { dateWindow } = require("../google/googleAdsSyncService");

class MetaAdsSyncService {
  constructor(repository) { this.repository = repository; }

  async syncJob(job) {
    const context = await this.repository.loadSyncContext(job);
    if (!context || !context.sync_enabled || context.connection_status !== "active") {
      await this.repository.dropJob(job.id);
      return { skipped: true, reason: "account_or_connection_inactive" };
    }
    if (context.access_token_expires_at && new Date(context.access_token_expires_at).getTime() <= Date.now()) {
      const error = new Error("Meta access token expired. Reconnect the Meta account.");
      error.code = "META_ACCESS_TOKEN_EXPIRED";
      const runId = await this.repository.startRun(job, "token_check");
      await this.repository.finishRun(job, runId, {
        success: false, error, cursor: null, syncIntervalMinutes: env.metaSyncIntervalMinutes,
      });
      throw error;
    }

    const initial = !context.last_synced_at;
    const window = dateWindow(initial ? env.metaInitialLookbackDays : env.metaRecentLookbackDays);
    const runId = await this.repository.startRun(job, initial ? "initial_backfill" : "recent_refresh");
    try {
      const client = new MetaGraphClient({ accessToken: context.accessToken });
      const data = await client.fetchSnapshot({
        accountExternalId: context.external_account_id,
        startDate: window.startDate,
        endDate: window.endDate,
      });
      await this.repository.persistSnapshot({
        tenantId: job.tenant_id,
        workspaceId: context.workspace_id,
        adAccountId: context.ad_account_id,
        data,
        window,
      });
      await this.repository.finishRun(job, runId, {
        success: true,
        cursor: { startDate: window.startDate, endDate: window.endDate, ...data.counts },
        syncIntervalMinutes: env.metaSyncIntervalMinutes,
      });
      return { success: true, window, counts: data.counts };
    } catch (error) {
      await this.repository.finishRun(job, runId, {
        success: false,
        error,
        cursor: { startDate: window.startDate, endDate: window.endDate },
        syncIntervalMinutes: env.metaSyncIntervalMinutes,
      });
      throw error;
    }
  }
}

module.exports = { MetaAdsSyncService };
