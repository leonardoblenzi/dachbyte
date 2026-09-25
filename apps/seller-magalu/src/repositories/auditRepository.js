"use strict";

const db = require("../config/postgres");
const { normalizeAuditEvent } = require("../services/auditSanitizer");

async function appendAuditEvent(event, { client = null } = {}) {
  const normalized = normalizeAuditEvent(event);
  const executor = client || db;
  const sql = `insert into magalu.audit_events(
      account_id,operation_id,dach_tenant_id,dach_user_id,action,resource_type,sku,details,
      event_key,category,severity,outcome,magalu_tenant_id,batch_id,request_id,source
    ) values(
      $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,
      coalesce($13,(select magalu_tenant_id from magalu.accounts where id=$1)),
      coalesce($14,(select preview_id::text from magalu.write_operations where id=$2)),
      coalesce($15,(select request_id from magalu.write_operations where id=$2)),$16
    ) returning id,created_at,event_key,category,severity,outcome`;
  const params = [
    normalized.accountId, normalized.operationId, normalized.dachTenantId, normalized.dachUserId,
    normalized.action, normalized.resourceType, normalized.sku, JSON.stringify(normalized.details),
    normalized.eventKey, normalized.category, normalized.severity, normalized.outcome,
    normalized.magaluTenantId, normalized.batchId, normalized.requestId, normalized.source,
  ];
  const result = await executor.query(sql, params);
  return result.rows?.[0] || null;
}

module.exports = { appendAuditEvent };
