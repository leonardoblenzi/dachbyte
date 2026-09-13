"use strict";

const db = require("../../../db/db");
const logger = require("../../observability/logger");

function retentionDays(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

async function pruneIntegrationHistory(options = {}) {
  const completedDays = retentionDays(options.completedDays || process.env.VOLT_CORE_INTEGRATION_RETENTION_DAYS, 30);
  const webhookDays = retentionDays(options.webhookDays || process.env.VOLT_CORE_WEBHOOK_RETENTION_DAYS, 30);
  return db.withRlsBypass(() => db.withClient(async (client) => {
    await client.query("begin");
    try {
      const webhooks = await client.query(`delete from volt_core.integration_webhook_events
        where status='processed' and processed_at < now() - ($1::int * interval '1 day') returning id`, [webhookDays]);
      const outbox = await client.query(`delete from volt_core.integration_outbox_events
        where status in ('completed','canceled') and completed_at < now() - ($1::int * interval '1 day') returning id`, [completedDays]);
      const jobs = await client.query(`delete from volt_core.integration_jobs j
        where j.status in ('completed','canceled') and j.completed_at < now() - ($1::int * interval '1 day')
          and not exists (select 1 from volt_core.integration_webhook_events w where w.job_id=j.id and w.company_id=j.company_id)
        returning id`, [completedDays]);
      await client.query("commit");
      const counts = { webhooks: webhooks.rowCount, outbox: outbox.rowCount, jobs: jobs.rowCount };
      if (counts.webhooks || counts.outbox || counts.jobs) logger.info("integration.maintenance.pruned", counts);
      return counts;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }));
}

module.exports = { pruneIntegrationHistory };
