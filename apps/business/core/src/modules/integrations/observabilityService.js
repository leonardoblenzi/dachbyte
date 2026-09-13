"use strict";

const db = require("../../../db/db");
const metrics = require("../../observability/metrics");
const { getIntegrationWorker } = require("./worker");
const { extensionRegistry } = require("../../platform/extensions/extensionRegistry");

async function getGlobalObservability() {
  const memory = metrics.snapshot();
  const pool = db.pool ? {
    totalCount: db.pool.totalCount,
    idleCount: db.pool.idleCount,
    waitingCount: db.pool.waitingCount,
  } : null;

  let integrations = null;
  if (db.isDatabaseEnabled()) {
    integrations = await db.withRlsBypass(async () => {
      const [summary, deadLetters] = await Promise.all([
        db.query(`select
          (select count(*)::int from volt_core.integration_accounts where status='active') as "activeAccounts",
          (select count(*)::int from volt_core.integration_jobs where status in ('queued','retrying','processing')) as "pendingJobs",
          (select count(*)::int from volt_core.integration_jobs where status='dead_letter') as "deadLetterJobs",
          (select count(*)::int from volt_core.integration_outbox_events where status in ('pending','retrying','processing')) as "pendingOutbox",
          (select count(*)::int from volt_core.integration_outbox_events where status='dead_letter') as "deadLetterOutbox",
          (select count(*)::int from volt_core.integration_webhook_events where received_at >= now()-interval '24 hours') as "webhooks24h"`),
        db.query(`select company_id as "companyId",type,status,last_error_code as "errorCode",
          last_error_message as "errorMessage",attempts,created_at as "createdAt"
          from volt_core.integration_jobs where status='dead_letter' order by updated_at desc limit 20`),
      ]);
      return { ...(summary.rows[0] || {}), recentDeadLetters: deadLetters.rows };
    });
  }

  const extensions = extensionRegistry.runtimeStatus();
  return { memory, pool, worker: getIntegrationWorker().status(), integrations, extensions };
}

module.exports = { getGlobalObservability };
