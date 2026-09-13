"use strict";

const db = require("../../../../../db/db");
const { insertOutboxEventWithClient } = require("../../../integrations/outboxStore");

async function nextOperationalNumber(client, companyId, counterKey) {
  const table = String(counterKey || "").trim();
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(table)) throw new Error(`Contador operacional invalido: ${counterKey}`);
  const result = await client.query(`
    insert into volt_core.operational_counters (company_id, counter_key, current_value)
    values ($1, $2, (select coalesce(max(number), 0) + 1 from volt_core.${table} where company_id = $1))
    on conflict (company_id, counter_key) do update
      set current_value = volt_core.operational_counters.current_value + 1,
          updated_at = now()
    returning current_value;
  `, [companyId, counterKey]);
  return Number(result.rows[0].current_value);
}

async function insertDomainEventWithClient(client, companyId, type, payload) {
  const event = await client.query(`
    insert into volt_core.events (company_id, type, payload)
    values ($1, $2, $3::jsonb)
    returning id;
  `, [companyId, type, JSON.stringify(payload || {})]);
  const eventId = event.rows[0]?.id;
  await insertOutboxEventWithClient(client, companyId, type, payload || {}, {
    idempotencyKey: eventId == null ? null : `domain-event:${eventId}`,
  });
  return eventId;
}

async function recordEvent(companyId, type, payload) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const eventId = await insertDomainEventWithClient(client, companyId, type, payload);
      await client.query("commit");
      return eventId;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function insertEventWithClient(client, companyId, type, payload) {
  return insertDomainEventWithClient(client, companyId, type, payload);
}

async function insertWorkflowEventWithClient(client, companyId, workflowKey, entityType, entityId, fromStatus, toStatus, actorUserId, metadata = {}) {
  await client.query(`
    insert into volt_core.workflow_events (company_id, workflow_key, entity_type, entity_id, from_status, to_status, actor_user_id, metadata)
    values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb);
  `, [companyId, workflowKey, entityType, entityId, fromStatus || null, toStatus, actorUserId || null, JSON.stringify(metadata || {})]);
}

async function insertAuditWithClient(client, companyId, actorUserId, action, entityType, entityId, before, after, metadata = {}) {
  await client.query(`
    insert into volt_core.audit_logs (
      company_id, actor_user_id, action, entity_type, entity_id, before_payload, after_payload, metadata
    ) values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb);
  `, [companyId, actorUserId || null, action, entityType || null, entityId || null,
    JSON.stringify(before ?? null), JSON.stringify(after ?? null), JSON.stringify(metadata || {})]);
}

module.exports = {
  insertAuditWithClient,
  insertEventWithClient,
  insertWorkflowEventWithClient,
  nextOperationalNumber,
  recordEvent,
};
