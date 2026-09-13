"use strict";

const db = require("../../../db/db");

function normalizeEntityType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(normalized)) throw new TypeError("Invalid extension entity type");
  return normalized;
}

async function upsertEntityExtensionDataWithClient(client, companyId, entityType, entityId, extensionKey, data) {
  const type = normalizeEntityType(entityType);
  const result = await client.query(`
    insert into volt_core.entity_extension_data
      (company_id, entity_type, entity_id, extension_key, data, created_at, updated_at)
    values ($1,$2,$3,$4,$5::jsonb,now(),now())
    on conflict (company_id, entity_type, entity_id, extension_key)
    do update set data=excluded.data, updated_at=now()
    returning data;
  `, [companyId, type, entityId, extensionKey, JSON.stringify(data || {})]);
  return result.rows[0]?.data || {};
}

async function deleteEntityExtensionDataWithClient(client, companyId, entityType, entityId, extensionKey = null) {
  const type = normalizeEntityType(entityType);
  const params = [companyId, type, entityId];
  const extensionFilter = extensionKey ? " and extension_key=$4" : "";
  if (extensionKey) params.push(extensionKey);
  await client.query(`delete from volt_core.entity_extension_data where company_id=$1 and entity_type=$2 and entity_id=$3${extensionFilter}`, params);
}

async function listEntityExtensionData(companyId, entityType, entityIds, client = db) {
  const type = normalizeEntityType(entityType);
  const ids = [...new Set((entityIds || []).map((value) => String(value || "").trim()).filter(Boolean))];
  if (!ids.length) return new Map();
  const result = await client.query(`
    select entity_id as "entityId", extension_key as "extensionKey", data
    from volt_core.entity_extension_data
    where company_id=$1 and entity_type=$2 and entity_id=any($3::text[])
  `, [companyId, type, ids]);
  const byEntity = new Map(ids.map((id) => [id, {}]));
  for (const row of result.rows) {
    const current = byEntity.get(row.entityId) || {};
    current[row.extensionKey] = row.data || {};
    byEntity.set(row.entityId, current);
  }
  return byEntity;
}

module.exports = {
  deleteEntityExtensionDataWithClient,
  listEntityExtensionData,
  upsertEntityExtensionDataWithClient,
};
