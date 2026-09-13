"use strict";

async function audit(client, { tenantId = null, actorUserId = null, actorType = "user", action, resourceType = null, resourceId = null, metadata = {}, ip = null, userAgent = null }) {
  await client.query(
    `INSERT INTO volt_price.audit_logs
      (tenant_id, actor_user_id, actor_type, action, resource_type, resource_id, metadata, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
    [tenantId, actorUserId, actorType, action, resourceType, resourceId ? String(resourceId) : null, JSON.stringify(metadata || {}), ip, userAgent],
  );
}

module.exports = { audit };
