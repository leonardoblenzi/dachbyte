"use strict";

const db = require("../config/postgres");

function text(value) { return String(value == null ? "" : value).trim(); }
function ownershipConflict() {
  const error = new Error("Esta organização Magalu já está vinculada a outra empresa DACHBYTE.");
  error.code = "MAGALU_TENANT_ALREADY_LINKED";
  error.status = 409;
  return error;
}
function normalizeScopes(scopes) { return Array.from(new Set((Array.isArray(scopes) ? scopes : []).map(text).filter(Boolean))); }

async function listAccountsForTenant(dachTenantId) {
  const { rows } = await db.query(
    `select a.id, a.dach_tenant_id, a.magalu_tenant_id, a.magalu_tenant_name,
            a.status, a.scopes, a.connected_at, a.last_oauth_at,
            a.catalog_sync_status, a.catalog_last_synced_at, a.catalog_last_error,
            a.hub_resource_key, a.hub_sync_status, a.hub_synced_at, a.hub_sync_error,
            a.created_at, a.updated_at,
            t.access_expires_at, t.refresh_expires_at, t.token_type,
            t.token_version, t.last_refresh_at, t.last_refresh_attempt_at,
            t.last_refresh_error
       from magalu.accounts a
       left join magalu.tokens t on t.account_id = a.id
      where a.dach_tenant_id = $1
      order by case when a.status = 'active' then 0 else 1 end,
               coalesce(a.magalu_tenant_name, a.magalu_tenant_id) asc`,
    [String(dachTenantId)],
  );
  return rows;
}

async function findAccountByTenantId(magaluTenantId) {
  return db.queryOne(
    `select id, dach_tenant_id, dach_created_by_user_id, magalu_tenant_id,
            magalu_tenant_name, status, scopes, metadata, connected_at,
            last_oauth_at, catalog_sync_status, catalog_last_synced_at,
            catalog_last_error, hub_resource_key, hub_sync_status, hub_synced_at,
            hub_sync_error, created_at, updated_at
       from magalu.accounts where magalu_tenant_id = $1 limit 1`,
    [String(magaluTenantId)],
  );
}

async function findAccountById(accountId) {
  return db.queryOne(
    `select a.id, a.dach_tenant_id, a.dach_created_by_user_id, a.magalu_tenant_id,
            a.magalu_tenant_name, a.status, a.scopes, a.metadata, a.connected_at,
            a.last_oauth_at, a.catalog_sync_status, a.catalog_last_synced_at,
            a.catalog_last_error, a.hub_resource_key, a.hub_sync_status, a.hub_synced_at,
            a.hub_sync_error, a.created_at, a.updated_at,
            t.access_expires_at, t.refresh_expires_at, t.token_type,
            t.token_version, t.last_refresh_at, t.last_refresh_attempt_at,
            t.last_refresh_error
       from magalu.accounts a left join magalu.tokens t on t.account_id = a.id
      where a.id = $1 limit 1`, [Number(accountId)]);
}

async function findAccountByIdForTenant(accountId, dachTenantId) {
  return db.queryOne(
    `select a.id, a.dach_tenant_id, a.dach_created_by_user_id, a.magalu_tenant_id,
            a.magalu_tenant_name, a.status, a.scopes, a.metadata, a.connected_at,
            a.last_oauth_at, a.catalog_sync_status, a.catalog_last_synced_at,
            a.catalog_last_error, a.hub_resource_key, a.hub_sync_status, a.hub_synced_at,
            a.hub_sync_error, a.created_at, a.updated_at,
            t.access_expires_at, t.refresh_expires_at, t.token_type,
            t.token_version, t.last_refresh_at, t.last_refresh_attempt_at,
            t.last_refresh_error
       from magalu.accounts a left join magalu.tokens t on t.account_id = a.id
      where a.id = $1 and a.dach_tenant_id = $2 limit 1`, [Number(accountId), String(dachTenantId)]);
}

async function updateExistingAccount(client, existingId, { dachUserId, scopes, metadata }) {
  const { rows } = await client.query(
    `update magalu.accounts
        set dach_created_by_user_id = coalesce(dach_created_by_user_id, $2), status = 'active',
            scopes = $3::text[], metadata = coalesce(metadata, '{}'::jsonb) || $4::jsonb,
            connected_at = coalesce(connected_at, now()), last_oauth_at = now(), revoked_at = null, updated_at = now()
      where id = $1
      returning id, dach_tenant_id, magalu_tenant_id, magalu_tenant_name, status, scopes, metadata,
                connected_at, last_oauth_at, created_at, updated_at`,
    [Number(existingId), text(dachUserId) || null, normalizeScopes(scopes), JSON.stringify(metadata || {})],
  );
  return rows[0] || null;
}

async function upsertConnectedAccount(client, { dachTenantId, dachUserId, magaluTenantId, scopes = [], metadata = {} }) {
  const existing = (await client.query(
    `select id, dach_tenant_id, magalu_tenant_id from magalu.accounts
      where magalu_tenant_id = $1 limit 1 for update`, [String(magaluTenantId)])).rows[0] || null;
  if (existing && String(existing.dach_tenant_id) !== String(dachTenantId)) throw ownershipConflict();
  if (existing) return updateExistingAccount(client, existing.id, { dachUserId, scopes, metadata });

  await client.query("savepoint magalu_account_insert");
  try {
    const { rows } = await client.query(
      `insert into magalu.accounts
         (dach_tenant_id, dach_created_by_user_id, magalu_tenant_id, status, scopes, metadata, connected_at, last_oauth_at)
       values ($1, $2, $3, 'active', $4::text[], $5::jsonb, now(), now())
       returning id, dach_tenant_id, magalu_tenant_id, magalu_tenant_name, status, scopes, metadata,
                 connected_at, last_oauth_at, created_at, updated_at`,
      [String(dachTenantId), text(dachUserId) || null, String(magaluTenantId), normalizeScopes(scopes), JSON.stringify(metadata || {})],
    );
    await client.query("release savepoint magalu_account_insert");
    return rows[0] || null;
  } catch (error) {
    await client.query("rollback to savepoint magalu_account_insert").catch(() => {});
    await client.query("release savepoint magalu_account_insert").catch(() => {});
    if (String(error?.code || "") !== "23505") throw error;
    const raced = (await client.query(
      `select id, dach_tenant_id, magalu_tenant_id from magalu.accounts
        where magalu_tenant_id = $1 limit 1 for update`, [String(magaluTenantId)])).rows[0] || null;
    if (!raced) throw error;
    if (String(raced.dach_tenant_id) !== String(dachTenantId)) throw ownershipConflict();
    return updateExistingAccount(client, raced.id, { dachUserId, scopes, metadata });
  }
}

async function updateAccountAfterRefresh(client, accountId, scopes = []) {
  const { rows } = await client.query(
    `update magalu.accounts set status = 'active', scopes = case when cardinality($2::text[]) > 0 then $2::text[] else scopes end,
            updated_at = now() where id = $1 returning id, dach_tenant_id, magalu_tenant_id, status, scopes, updated_at`,
    [Number(accountId), normalizeScopes(scopes)]);
  return rows[0] || null;
}

async function updateSellerProfile(accountId, profile) {
  const name = text(profile?.name || profile?.trade_name || profile?.display_name || profile?.nickname || profile?.seller_name);
  const { rows } = await db.query(
    `update magalu.accounts set magalu_tenant_name = coalesce(nullif($2, ''), magalu_tenant_name),
            metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{seller_profile}', $3::jsonb, true), updated_at = now()
      where id = $1 returning id, magalu_tenant_name, metadata`, [Number(accountId), name || null, JSON.stringify(profile || {})]);
  return rows[0] || null;
}

async function setCatalogSyncState(accountId, { status, error = null, syncedAt = null } = {}) {
  await db.query(
    `update magalu.accounts set catalog_sync_status = coalesce($2, catalog_sync_status), catalog_last_error = $3,
            catalog_last_synced_at = coalesce($4::timestamptz, catalog_last_synced_at), updated_at = now() where id = $1`,
    [Number(accountId), status || null, error ? String(error).slice(0, 2000) : null, syncedAt || null]);
}

async function setHubResourceSyncState(accountId, { status, hubResourceKey = null, error = null, syncedAt = null } = {}) {
  await db.query(
    `update magalu.accounts
        set hub_sync_status = coalesce($2, hub_sync_status),
            hub_resource_key = coalesce($3, hub_resource_key),
            hub_sync_error = $4,
            hub_synced_at = coalesce($5::timestamptz, hub_synced_at),
            updated_at = now()
      where id = $1`,
    [Number(accountId), status || null, hubResourceKey || null, error ? String(error).slice(0, 2000) : null, syncedAt || null],
  );
}

async function markAccountActive(accountId) { await db.query(`update magalu.accounts set status = 'active', updated_at = now() where id = $1`, [Number(accountId)]); }

module.exports = {
  listAccountsForTenant, findAccountByTenantId, findAccountById, findAccountByIdForTenant,
  upsertConnectedAccount, updateAccountAfterRefresh, updateSellerProfile, setCatalogSyncState, setHubResourceSyncState, markAccountActive,
  _test: { ownershipConflict, normalizeScopes },
};
