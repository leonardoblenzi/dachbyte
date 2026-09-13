"use strict";

const db = require("../../../db/db");
const { createId } = require("../core/id");
const { enqueueJobWithClient } = require("./jobStore");
const { normalizeProvider, sanitizeHeaders } = require("./helpers");

async function ingestWebhook(companyId, input = {}) {
  const provider = normalizeProvider(input.provider);
  const externalEventId = String(input.externalEventId || "").trim();
  const eventType = String(input.eventType || "").trim();
  if (!externalEventId || !eventType) {
    const error = new Error("externalEventId e eventType sao obrigatorios.");
    error.statusCode = 400;
    error.code = "WEBHOOK_EVENT_INVALID";
    throw error;
  }

  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const eventId = createId("wh");
      const eventInsert = await client.query(`insert into volt_core.integration_webhook_events
        (id,company_id,account_id,provider,external_event_id,event_type,status,payload,headers)
        values ($1,$2,$3,$4,$5,$6,'received',$7::jsonb,$8::jsonb)
        on conflict do nothing
        returning *`,
      [eventId, companyId, input.accountId || null, provider, externalEventId, eventType,
        JSON.stringify(input.payload || {}), JSON.stringify(sanitizeHeaders(input.headers || {}))]);

      if (!eventInsert.rowCount) {
        const existing = await client.query(`select * from volt_core.integration_webhook_events
          where company_id=$1 and provider=$2 and account_id is not distinct from $3 and external_event_id=$4 limit 1`,
        [companyId, provider, input.accountId || null, externalEventId]);
        await client.query("commit");
        return { event: existing.rows[0], duplicate: true };
      }

      const job = await enqueueJobWithClient(client, companyId, {
        accountId: input.accountId || null,
        type: input.jobType || `webhook.${provider}.${eventType}`,
        payload: { webhookEventId: eventId, provider, eventType, payload: input.payload || {} },
        idempotencyKey: `webhook:${provider}:${input.accountId || "none"}:${externalEventId}`,
        correlationId: input.correlationId || externalEventId,
        maxAttempts: input.maxAttempts || 5,
        createdBy: input.createdBy || null,
      });
      const updated = await client.query(`update volt_core.integration_webhook_events
        set status='queued',job_id=$4 where company_id=$1 and provider=$2 and external_event_id=$3 returning *`,
      [companyId, provider, externalEventId, job.id]);
      await client.query("commit");
      return { event: updated.rows[0] || eventInsert.rows[0], job, duplicate: false };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function markWebhookProcessed(companyId, webhookEventId, { status = "processed", errorCode = null, errorMessage = null } = {}) {
  const result = await db.query(`update volt_core.integration_webhook_events
    set status=$3,error_code=$4,error_message=$5,processed_at=now()
    where company_id=$1 and id=$2 returning *`,
  [companyId, webhookEventId, status, errorCode, errorMessage]);
  return result.rows[0] || null;
}

module.exports = { ingestWebhook, markWebhookProcessed };
