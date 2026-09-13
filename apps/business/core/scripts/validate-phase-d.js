"use strict";

const assert = require("node:assert/strict");
const db = require("../db/db");
const { enqueueJob, retryJob } = require("../src/modules/integrations/jobStore");
const { enqueueOutboxEvent } = require("../src/modules/integrations/outboxStore");
const { ingestWebhook } = require("../src/modules/integrations/webhookService");
const { processJobById } = require("../src/modules/integrations/jobEngine");
const { processOutboxById } = require("../src/modules/integrations/outboxEngine");

async function firstCompanyId() {
  const requested = String(process.env.VOLT_CORE_PHASE_D_COMPANY_ID || "").trim();
  if (requested) return requested;
  return db.withRlsBypass(async () => {
    const result = await db.query("select id from volt_core.companies where status='active' order by created_at asc limit 1");
    return result.rows[0]?.id || null;
  });
}

async function waitFor(read, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let value = null;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout aguardando estado da Fase D: ${JSON.stringify(value)}`);
}

async function cleanup(companyId, ids) {
  await db.withRlsBypass(() => db.withClient(async (client) => {
    await client.query("begin");
    try {
      if (ids.webhookEventId) await client.query("delete from volt_core.integration_webhook_events where company_id=$1 and id=$2", [companyId, ids.webhookEventId]);
      for (const jobId of ids.jobIds || []) {
        await client.query("delete from volt_core.integration_job_attempts where company_id=$1 and job_id=$2", [companyId, jobId]);
        await client.query("delete from volt_core.integration_jobs where company_id=$1 and id=$2", [companyId, jobId]);
      }
      for (const outboxId of ids.outboxIds || []) await client.query("delete from volt_core.integration_outbox_events where company_id=$1 and id=$2", [companyId, outboxId]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }));
}

async function main() {
  if (!db.isDatabaseEnabled()) throw new Error("VOLT_CORE_APP_DATABASE_URL e obrigatoria para validate:phase-d.");
  const companyId = await firstCompanyId();
  if (!companyId) throw new Error("Nenhuma empresa ativa encontrada para o diagnostico da Fase D.");

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workerId = `phase-d-validator-${process.pid}`;
  const ids = { jobIds: [], outboxIds: [], webhookEventId: null };

  try {
    await db.withTenantContext(companyId, async () => {
      const noop = await enqueueJob(companyId, {
        type: "system.noop",
        payload: { probe: suffix },
        idempotencyKey: `phase-d:noop:${suffix}`,
        maxAttempts: 2,
      });
      ids.jobIds.push(noop.id);
      await processJobById(workerId, noop.id);
      const noopCheck = await waitFor(
        () => db.query("select status,result from volt_core.integration_jobs where company_id=$1 and id=$2", [companyId, noop.id]),
        (value) => value.rows[0]?.status === "completed",
      );
      assert.equal(noopCheck.rows[0]?.result?.echo?.probe, suffix);

      const dead = await enqueueJob(companyId, {
        type: "system.recovery_probe",
        payload: { probe: suffix },
        idempotencyKey: `phase-d:dead:${suffix}`,
        maxAttempts: 3,
      });
      ids.jobIds.push(dead.id);
      await processJobById(workerId, dead.id);
      let deadCheck = await waitFor(
        () => db.query("select status,last_error_code from volt_core.integration_jobs where company_id=$1 and id=$2", [companyId, dead.id]),
        (value) => value.rows[0]?.status === "dead_letter",
      );
      assert.equal(deadCheck.rows[0]?.last_error_code, "PHASE_D_EXPECTED_FAILURE");

      await retryJob(companyId, dead.id, "phase-d-validator");
      await processJobById(workerId, dead.id);
      deadCheck = await waitFor(
        () => db.query("select status,result,manual_retries from volt_core.integration_jobs where company_id=$1 and id=$2", [companyId, dead.id]),
        (value) => value.rows[0]?.status === "completed",
      );
      assert.equal(Number(deadCheck.rows[0]?.manual_retries), 1);
      assert.equal(deadCheck.rows[0]?.result?.recovered, true);

      const outbox = await enqueueOutboxEvent(companyId, "system.phase_d_probe", { probe: suffix }, { idempotencyKey: `phase-d:outbox:${suffix}` });
      ids.outboxIds.push(outbox.id);
      await processOutboxById(workerId, outbox.id);
      const outboxCheck = await waitFor(
        () => db.query("select status,result from volt_core.integration_outbox_events where company_id=$1 and id=$2", [companyId, outbox.id]),
        (value) => value.rows[0]?.status === "completed",
      );
      assert.equal(outboxCheck.rows[0]?.result?.outputs?.[0]?.consumed, true);

      const missingOutbox = await processOutboxById(workerId, `outbox-missing-${suffix}`);
      assert.equal(missingOutbox, null);

      const webhookInput = {
        provider: "phase-d",
        externalEventId: `evt-${suffix}`,
        eventType: "probe",
        payload: { probe: suffix },
        headers: { "content-type": "application/json", authorization: "MUST_NOT_BE_STORED" },
        jobType: "system.noop",
        maxAttempts: 2,
      };
      const firstWebhook = await ingestWebhook(companyId, webhookInput);
      ids.webhookEventId = firstWebhook.event.id;
      ids.jobIds.push(firstWebhook.job.id);
      const duplicateWebhook = await ingestWebhook(companyId, webhookInput);
      assert.equal(firstWebhook.duplicate, false);
      assert.equal(duplicateWebhook.duplicate, true);
      assert.equal(duplicateWebhook.event.id, firstWebhook.event.id);
      await processJobById(workerId, firstWebhook.job.id);
      const webhookCheck = await waitFor(
        () => db.query("select status,headers from volt_core.integration_webhook_events where company_id=$1 and id=$2", [companyId, firstWebhook.event.id]),
        (value) => value.rows[0]?.status === "processed",
      );
      assert.equal(Object.prototype.hasOwnProperty.call(webhookCheck.rows[0]?.headers || {}, "authorization"), false);
    });

    console.log(JSON.stringify({
      ok: true,
      companyId,
      checks: ["job_completed", "dead_letter", "manual_retry", "outbox_dispatch", "empty_outbox_noop", "webhook_deduplication", "webhook_header_sanitization"],
    }, null, 2));
  } finally {
    await cleanup(companyId, ids).catch((error) => console.error("[phase-d] cleanup falhou:", error.message));
    if (db.pool) await db.pool.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error("[phase-d] validacao falhou:", error);
  process.exitCode = 1;
});
