"use strict";

const db = require("../../../db/db");
const { createId } = require("../core/id");
const { badRequest, notFound } = require("../core/errors");
const { effectiveLimit } = require("../core/configuration/configurationEngine");
const { getCompanyConfiguration } = require("../core/runtime/services/configurationService");
const { assertConfigHasNoSecrets, normalizeCredentialRef, normalizeProvider } = require("./helpers");
const { enqueueJob, retryJob: retryJobStore } = require("./jobStore");
const { retryOutbox: retryOutboxStore } = require("./outboxStore");
const { insertAuditWithClient, insertEventWithClient } = require("../core/runtime/services/persistenceHelpers");

function pageInput(query = {}, max = 100) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.min(max, Math.max(1, Number.parseInt(query.pageSize, 10) || 25));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

async function assertIntegrationCapacity(client, companyId, limit, excludeAccountId = null) {
  if (!(limit > 0)) return;
  const count = await client.query(`select count(*)::int as total from volt_core.integration_accounts
    where company_id=$1 and status <> 'disabled' and ($2::text is null or id <> $2)`, [companyId, excludeAccountId]);
  if (Number(count.rows[0]?.total || 0) >= limit) {
    const error = new Error(`Limite de ${limit} integracoes atingido para esta empresa.`);
    error.statusCode = 409;
    error.code = "INTEGRATION_LIMIT_REACHED";
    throw error;
  }
}

async function listIntegrationAccounts(companyId) {
  const result = await db.query(`select id,provider,external_account_id as "externalAccountId",display_name as "displayName",
    status,credential_ref as "credentialRef",config,last_sync_at as "lastSyncAt",last_error_code as "lastErrorCode",
    last_error_message as "lastErrorMessage",created_at as "createdAt",updated_at as "updatedAt"
    from volt_core.integration_accounts where company_id=$1 order by provider,display_name`, [companyId]);
  return result.rows;
}

async function saveIntegrationAccount(companyId, input = {}) {
  const provider = normalizeProvider(input.provider);
  const config = input.config && typeof input.config === "object" ? input.config : {};
  assertConfigHasNoSecrets(config);
  const externalAccountId = String(input.externalAccountId || "default").trim() || "default";
  const displayName = String(input.displayName || `${provider}:${externalAccountId}`).trim();
  const credentialRef = normalizeCredentialRef(input.credentialRef);
  const configuration = await getCompanyConfiguration(companyId);
  const limit = Number(effectiveLimit(configuration, "integrations", 0) || 0);
  const nextStatus = ["active","disabled","error"].includes(input.status) ? input.status : "active";

  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const current = await client.query(`select * from volt_core.integration_accounts
        where company_id=$1 and provider=$2 and external_account_id=$3 limit 1 for update`, [companyId, provider, externalAccountId]);
      if (nextStatus !== "disabled" && (!current.rowCount || current.rows[0]?.status === "disabled")) {
        await assertIntegrationCapacity(client, companyId, limit, current.rows[0]?.id || null);
      }
      const id = current.rows[0]?.id || createId("intacct");
      const result = await client.query(`insert into volt_core.integration_accounts
        (id,company_id,provider,external_account_id,display_name,status,credential_ref,config,created_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
        on conflict (company_id,provider,external_account_id) do update set
          display_name=excluded.display_name,status=excluded.status,credential_ref=excluded.credential_ref,
          config=excluded.config,updated_at=now()
        returning *`, [id, companyId, provider, externalAccountId, displayName,
          nextStatus, credentialRef,
          JSON.stringify(config), input.actorUserId || null]);
      const saved = result.rows[0];
      await insertAuditWithClient(client, companyId, input.actorUserId, current.rowCount ? "integration.account.updated" : "integration.account.created",
        "integration_account", id, current.rows[0] || null, saved, { provider, externalAccountId });
      await insertEventWithClient(client, companyId, current.rowCount ? "integration.account.updated" : "integration.account.created", { accountId: id, provider });
      await client.query("commit");
      return saved;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function setIntegrationAccountStatus(companyId, accountId, status, actorUserId) {
  if (!["active","disabled","error"].includes(status)) throw badRequest("Status de integracao invalido.", "INTEGRATION_STATUS_INVALID");
  const configuration = await getCompanyConfiguration(companyId);
  const limit = Number(effectiveLimit(configuration, "integrations", 0) || 0);
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const before = await client.query("select * from volt_core.integration_accounts where company_id=$1 and id=$2 limit 1 for update", [companyId, accountId]);
      if (!before.rowCount) throw notFound("Integracao nao encontrada.", "INTEGRATION_ACCOUNT_NOT_FOUND");
      if (status !== "disabled" && before.rows[0].status === "disabled") await assertIntegrationCapacity(client, companyId, limit, accountId);
      const result = await client.query(`update volt_core.integration_accounts set status=$3,updated_at=now()
        where company_id=$1 and id=$2 returning *`, [companyId, accountId, status]);
      await insertAuditWithClient(client, companyId, actorUserId, "integration.account.status_changed", "integration_account", accountId,
        before.rows[0], result.rows[0], { status });
      await insertEventWithClient(client, companyId, "integration.account.status_changed", { accountId, status });
      await client.query("commit");
      return result.rows[0];
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function upsertMapping(companyId, input = {}) {
  const accountId = String(input.accountId || "").trim();
  const entityType = String(input.entityType || "").trim();
  const internalId = String(input.internalId || "").trim();
  const externalId = String(input.externalId || "").trim();
  if (!accountId || !entityType || !internalId || !externalId) throw badRequest("Mapeamento incompleto.", "INTEGRATION_MAPPING_INVALID");
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const account = await client.query("select id from volt_core.integration_accounts where company_id=$1 and id=$2 limit 1", [companyId, accountId]);
      if (!account.rowCount) throw notFound("Integracao nao encontrada para o mapeamento.", "INTEGRATION_ACCOUNT_NOT_FOUND");
      const before = await client.query(`select * from volt_core.integration_mappings
        where company_id=$1 and account_id=$2 and entity_type=$3 and internal_id=$4 limit 1 for update`,
      [companyId, accountId, entityType, internalId]);
      const id = before.rows[0]?.id || createId("imap");
      const result = await client.query(`insert into volt_core.integration_mappings
        (id,company_id,account_id,entity_type,internal_id,external_id,metadata)
        values ($1,$2,$3,$4,$5,$6,$7::jsonb)
        on conflict (company_id,account_id,entity_type,internal_id) do update set external_id=excluded.external_id,metadata=excluded.metadata,updated_at=now()
        returning *`, [id, companyId, accountId, entityType, internalId, externalId, JSON.stringify(input.metadata || {})]);
      await insertAuditWithClient(client, companyId, input.actorUserId, before.rowCount ? "integration.mapping.updated" : "integration.mapping.created",
        "integration_mapping", id, before.rows[0] || null, result.rows[0], { accountId, entityType });
      await client.query("commit");
      return result.rows[0];
    } catch (error) {
      await client.query("rollback");
      if (error?.code === "23505") {
        const conflict = new Error("ID externo ja esta mapeado para outra entidade.");
        conflict.statusCode = 409;
        conflict.code = "INTEGRATION_MAPPING_CONFLICT";
        throw conflict;
      }
      throw error;
    }
  });
}

async function listMappings(companyId, query = {}) {
  const { page, pageSize, offset } = pageInput(query);
  const accountId = String(query.accountId || "").trim();
  const entityType = String(query.entityType || "").trim();
  const search = String(query.search || "").trim();
  const params = [companyId, accountId || null, entityType || null, search || null, pageSize, offset];
  const where = `company_id=$1 and ($2::text is null or account_id=$2) and ($3::text is null or entity_type=$3)
    and ($4::text is null or internal_id ilike '%'||$4||'%' or external_id ilike '%'||$4||'%')`;
  const [rows, count] = await Promise.all([
    db.query(`select * from volt_core.integration_mappings where ${where} order by updated_at desc limit $5 offset $6`, params),
    db.query(`select count(*)::int as total from volt_core.integration_mappings where ${where}`, params.slice(0,4)),
  ]);
  return { rows: rows.rows, pagination: { page, pageSize, total: Number(count.rows[0]?.total || 0) } };
}

async function listJobs(companyId, query = {}) {
  const { page, pageSize, offset } = pageInput(query);
  const status = String(query.status || "").trim();
  const type = String(query.type || "").trim();
  const params = [companyId, status || null, type || null, pageSize, offset];
  const where = `company_id=$1 and ($2::text is null or status=$2) and ($3::text is null or type=$3)`;
  const [rows, count] = await Promise.all([
    db.query(`select * from volt_core.integration_jobs where ${where} order by created_at desc limit $4 offset $5`, params),
    db.query(`select count(*)::int as total from volt_core.integration_jobs where ${where}`, params.slice(0,3)),
  ]);
  return { rows: rows.rows, pagination: { page, pageSize, total: Number(count.rows[0]?.total || 0) } };
}

async function listOutbox(companyId, query = {}) {
  const { page, pageSize, offset } = pageInput(query);
  const status = String(query.status || "").trim();
  const eventType = String(query.eventType || "").trim();
  const params = [companyId, status || null, eventType || null, pageSize, offset];
  const where = `company_id=$1 and ($2::text is null or status=$2) and ($3::text is null or event_type=$3)`;
  const [rows, count] = await Promise.all([
    db.query(`select * from volt_core.integration_outbox_events where ${where} order by created_at desc limit $4 offset $5`, params),
    db.query(`select count(*)::int as total from volt_core.integration_outbox_events where ${where}`, params.slice(0,3)),
  ]);
  return { rows: rows.rows, pagination: { page, pageSize, total: Number(count.rows[0]?.total || 0) } };
}

async function listWebhooks(companyId, query = {}) {
  const { page, pageSize, offset } = pageInput(query);
  const provider = String(query.provider || "").trim().toLowerCase();
  const result = await db.query(`select * from volt_core.integration_webhook_events
    where company_id=$1 and ($2::text is null or provider=$2) order by received_at desc limit $3 offset $4`,
  [companyId, provider || null, pageSize, offset]);
  const count = await db.query(`select count(*)::int as total from volt_core.integration_webhook_events
    where company_id=$1 and ($2::text is null or provider=$2)`, [companyId, provider || null]);
  return { rows: result.rows, pagination: { page, pageSize, total: Number(count.rows[0]?.total || 0) } };
}

async function resolveIntegrationAccountGlobally(providerValue, externalAccountIdValue) {
  const provider = normalizeProvider(providerValue);
  const externalAccountId = String(externalAccountIdValue || "").trim();
  if (!externalAccountId) throw badRequest("Identificador externo da conta e obrigatorio.", "INTEGRATION_EXTERNAL_ACCOUNT_REQUIRED");
  return db.withRlsBypass(async () => {
    const result = await db.query(`select id,company_id as "companyId",provider,external_account_id as "externalAccountId",
      credential_ref as "credentialRef",config,status
      from volt_core.integration_accounts
      where provider=$1 and external_account_id=$2 and status='active'
      order by created_at asc limit 2`, [provider, externalAccountId]);
    if (!result.rowCount) throw notFound("Conta de integracao nao encontrada.", "INTEGRATION_ACCOUNT_NOT_FOUND");
    if (result.rowCount > 1) {
      const error = new Error("Conta externa vinculada a mais de uma empresa; webhook ambiguo.");
      error.statusCode = 409;
      error.code = "INTEGRATION_ACCOUNT_AMBIGUOUS";
      throw error;
    }
    return result.rows[0];
  });
}

async function getIntegrationSummary(companyId) {
  const result = await db.query(`select
    (select count(*)::int from volt_core.integration_accounts where company_id=$1 and status='active') as "activeAccounts",
    (select count(*)::int from volt_core.integration_jobs where company_id=$1 and status in ('queued','retrying','processing')) as "pendingJobs",
    (select count(*)::int from volt_core.integration_jobs where company_id=$1 and status='dead_letter') as "deadLetterJobs",
    (select count(*)::int from volt_core.integration_outbox_events where company_id=$1 and status in ('pending','retrying','processing')) as "pendingOutbox",
    (select count(*)::int from volt_core.integration_outbox_events where company_id=$1 and status='dead_letter') as "deadLetterOutbox",
    (select count(*)::int from volt_core.integration_webhook_events where company_id=$1 and received_at >= now()-interval '24 hours') as "webhooks24h"`, [companyId]);
  return result.rows[0] || {};
}

async function retryJob(companyId, jobId, actorUserId) {
  const job = await retryJobStore(companyId, jobId, actorUserId);
  await db.withClient((client) => insertAuditWithClient(client, companyId, actorUserId, "integration.job.manual_retry", "integration_job", jobId, null, job, {}));
  return job;
}

async function retryOutbox(companyId, eventId, actorUserId) {
  const event = await retryOutboxStore(companyId, eventId);
  await db.withClient((client) => insertAuditWithClient(client, companyId, actorUserId, "integration.outbox.manual_retry", "integration_outbox", eventId, null, event, {}));
  return event;
}

module.exports = {
  enqueueJob,
  getIntegrationSummary,
  listIntegrationAccounts,
  listJobs,
  listMappings,
  listOutbox,
  listWebhooks,
  retryJob,
  retryOutbox,
  resolveIntegrationAccountGlobally,
  saveIntegrationAccount,
  setIntegrationAccountStatus,
  upsertMapping,
};
