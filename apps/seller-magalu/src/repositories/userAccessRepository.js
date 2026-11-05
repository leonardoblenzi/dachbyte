"use strict";

const db = require("../config/postgres");

// O deploy da Magalu nao roda migrations; as tabelas da 019 tambem sao
// garantidas aqui para o codigo nunca depender da ordem deploy/migration.
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = db.query(`
      create schema if not exists magalu;
      create table if not exists magalu.tenant_users (
        dach_tenant_id text not null,
        dach_user_id text not null,
        email text not null,
        name text,
        company_role text,
        first_seen_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now(),
        primary key (dach_tenant_id, dach_user_id)
      );
      create table if not exists magalu.user_module_access (
        dach_tenant_id text not null,
        dach_user_id text not null,
        module_key text not null,
        can_access boolean not null default true,
        can_edit boolean not null default false,
        updated_by_user_id text,
        updated_at timestamptz not null default now(),
        primary key (dach_tenant_id, dach_user_id, module_key),
        constraint user_module_access_edit_requires_access check (can_access or not can_edit)
      );
      create index if not exists user_module_access_tenant_idx
        on magalu.user_module_access (dach_tenant_id);
    `).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

async function upsertSeenUser({ tenantId, userId, email, name, companyRole }) {
  await ensureSchema();
  await db.query(
    `insert into magalu.tenant_users (dach_tenant_id, dach_user_id, email, name, company_role)
     values ($1, $2, $3, $4, $5)
     on conflict (dach_tenant_id, dach_user_id) do update
       set email = excluded.email,
           name = coalesce(excluded.name, magalu.tenant_users.name),
           company_role = coalesce(excluded.company_role, magalu.tenant_users.company_role),
           last_seen_at = now()`,
    [tenantId, userId, email, name || null, companyRole || null],
  );
}

async function listModuleRows(tenantId, userId) {
  await ensureSchema();
  const { rows } = await db.query(
    `select module_key, can_access, can_edit
       from magalu.user_module_access
      where dach_tenant_id = $1 and dach_user_id = $2`,
    [tenantId, userId],
  );
  return rows;
}

async function listTenantUsers(tenantId) {
  await ensureSchema();
  const { rows } = await db.query(
    `select u.dach_user_id, u.email, u.name, u.company_role, u.first_seen_at, u.last_seen_at,
            coalesce(
              json_agg(json_build_object('module_key', m.module_key, 'can_access', m.can_access, 'can_edit', m.can_edit)
                       order by m.module_key) filter (where m.module_key is not null),
              '[]'::json
            ) as modules
       from magalu.tenant_users u
       left join magalu.user_module_access m
         on m.dach_tenant_id = u.dach_tenant_id and m.dach_user_id = u.dach_user_id
      where u.dach_tenant_id = $1
      group by u.dach_tenant_id, u.dach_user_id
      order by lower(coalesce(u.name, u.email)), u.email`,
    [tenantId],
  );
  return rows;
}

async function findTenantUser(tenantId, userId) {
  await ensureSchema();
  const { rows } = await db.query(
    `select dach_user_id, email, name, company_role
       from magalu.tenant_users
      where dach_tenant_id = $1 and dach_user_id = $2`,
    [tenantId, userId],
  );
  return rows[0] || null;
}

// Substitui todas as permissoes do usuario. rows vazio = acesso completo.
async function replaceModuleRows(tenantId, userId, rows, actorUserId) {
  await ensureSchema();
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      await client.query(
        "delete from magalu.user_module_access where dach_tenant_id = $1 and dach_user_id = $2",
        [tenantId, userId],
      );
      for (const row of rows) {
        await client.query(
          `insert into magalu.user_module_access
             (dach_tenant_id, dach_user_id, module_key, can_access, can_edit, updated_by_user_id)
           values ($1, $2, $3, $4, $5, $6)`,
          [tenantId, userId, row.module_key, row.can_access, row.can_edit, actorUserId || null],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

module.exports = {
  ensureSchema,
  upsertSeenUser,
  listModuleRows,
  listTenantUsers,
  findTenantUser,
  replaceModuleRows,
};
