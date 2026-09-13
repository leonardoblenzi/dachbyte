"use strict";

const db = require("../../../db/db");
const { createId } = require("../core/id");
const { getRequestContext } = require("../../observability/requestContext");
const { notifyIntegrationQueue } = require("./workerSignal");

function inferAggregate(payload = {}) {
  const entry = Object.entries(payload || {}).find(([key]) => /Id$/.test(key));
  if (!entry) return { aggregateType: null, aggregateId: null };
  return { aggregateType: entry[0].replace(/Id$/, ""), aggregateId: String(entry[1] || "") || null };
}

async function insertOutboxEventWithClient(client, companyId, eventType, payload = {}, options = {}) {
  const id = options.id || createId("outbox");
  const context = getRequestContext();
  const aggregate = inferAggregate(payload);
  const result = await client.query(`
    insert into volt_core.integration_outbox_events (
      id,company_id,event_type,aggregate_type,aggregate_id,payload,idempotency_key,correlation_id,request_id,max_attempts
    ) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
    on conflict (company_id,event_type,idempotency_key) where idempotency_key is not null
    do update set updated_at=volt_core.integration_outbox_events.updated_at
    returning *;
  `, [id, companyId, eventType, options.aggregateType || aggregate.aggregateType, options.aggregateId || aggregate.aggregateId,
    JSON.stringify(payload || {}), options.idempotencyKey || null, options.correlationId || context.requestId || null,
    options.requestId || context.requestId || null, Math.min(25, Math.max(1, Number(options.maxAttempts || 5)))]);
  return result.rows[0];
}

async function enqueueOutboxEvent(companyId, eventType, payload, options) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const event = await insertOutboxEventWithClient(client, companyId, eventType, payload, options);
      await client.query("commit");
      notifyIntegrationQueue();
      return event;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function claimOutbox(workerId, eventId = null) {
  const result = await db.withRlsBypass(() => db.query(`
    with candidate as (
      select id from volt_core.integration_outbox_events
       where status in ('pending','retrying') and available_at <= now()
         and ($2::text is null or id=$2)
       order by available_at asc, created_at asc
       for update skip locked limit 1
    )
    update volt_core.integration_outbox_events e
       set status='processing', attempts=e.attempts+1, locked_at=now(), locked_by=$1, updated_at=now()
      from candidate where e.id=candidate.id
    returning e.*;
  `, [workerId, eventId]));
  return result.rows[0] || null;
}

async function claimNextOutbox(workerId) { return claimOutbox(workerId, null); }
async function claimOutboxById(workerId, eventId) { return claimOutbox(workerId, String(eventId || "").trim()); }

async function finishOutbox(event, { status, result = null, errorCode = null, errorMessage = null, availableAt = null }) {
  return db.withRlsBypass(() => db.query(`
    update volt_core.integration_outbox_events
       set status=$3, result=$4::jsonb, last_error_code=$5, last_error_message=$6,
           available_at=coalesce($7::timestamptz,available_at), locked_at=null, locked_by=null,
           completed_at=case when $3 in ('completed','dead_letter') then now() else null end, updated_at=now()
     where company_id=$1 and id=$2 returning *;
  `, [event.company_id, event.id, status, result == null ? null : JSON.stringify(result), errorCode, errorMessage, availableAt]));
}

async function retryOutbox(companyId, eventId) {
  const result = await db.query(`
    update volt_core.integration_outbox_events
       set status='pending', attempts=0, available_at=now(), locked_at=null, locked_by=null,
           last_error_code=null,last_error_message=null,completed_at=null,updated_at=now()
     where company_id=$1 and id=$2 and status='dead_letter' returning *;
  `, [companyId, eventId]);
  if (!result.rowCount) {
    const error = new Error("Somente eventos em dead-letter podem ser reenfileirados.");
    error.statusCode = 409;
    error.code = "OUTBOX_EVENT_NOT_RETRYABLE";
    throw error;
  }
  notifyIntegrationQueue();
  return result.rows[0];
}

async function recoverStaleOutbox(leaseMs) {
  return db.withRlsBypass(() => db.query(`
    update volt_core.integration_outbox_events
       set status='retrying',available_at=now(),locked_at=null,locked_by=null,
           last_error_code='WORKER_LEASE_EXPIRED',last_error_message='Evento recuperado apos expirar o lease do worker.',updated_at=now()
     where status='processing' and locked_at < now() - ($1::bigint * interval '1 millisecond') returning id;
  `, [leaseMs]));
}

module.exports = { claimNextOutbox, claimOutboxById, enqueueOutboxEvent, finishOutbox, insertOutboxEventWithClient, recoverStaleOutbox, retryOutbox };
