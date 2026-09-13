"use strict";

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { syncHubIdentity, isHubSyncConfigured } = require("../lib/hubIdentitySync");

const moduleRoot = path.resolve(__dirname, "..");

[
  path.join(moduleRoot, ".env"),
  path.join(moduleRoot, "apps", "seller-ml", ".env"),
  path.join(moduleRoot, "apps", "seller-shopee", ".env"),
  path.join(moduleRoot, "apps", "seller-tracking", ".env"),
  path.join(moduleRoot, "apps", "seller-tracking", "server", ".env"),
  path.join(moduleRoot, "apps", "seller-madeira", ".env"),
].forEach((envPath) => {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
});

function resolvePgModule() {
  const candidates = [
    path.join(moduleRoot, "apps", "seller-ml"),
    path.join(moduleRoot, "apps", "seller-shopee"),
    path.join(moduleRoot, "apps", "seller-madeira"),
    path.join(moduleRoot, "apps", "seller-tracking", "server"),
    moduleRoot,
  ];

  for (const candidate of candidates) {
    try {
      return require(
        require.resolve("pg", {
          paths: [candidate],
        }),
      );
    } catch (_error) {}
  }

  throw new Error("Nao foi possivel localizar o pacote 'pg' para o backfill.");
}

const { Pool } = resolvePgModule();

function createPool(connectionString) {
  return new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 2,
  });
}

async function runQuery(connectionString, sqlText) {
  if (!String(connectionString || "").trim()) return [];
  const pool = createPool(connectionString);
  try {
    const result = await pool.query(sqlText);
    return result.rows || [];
  } finally {
    await pool.end().catch(() => {});
  }
}

async function syncRows(rows, source) {
  let synced = 0;
  let skipped = 0;

  for (const row of rows) {
    const result = await syncHubIdentity({
      tenant_id: row.tenant_id,
      company_name: row.company_name,
      document_type: row.document_type || null,
      document_number: row.document_number || null,
      user_id: row.user_id,
      full_name: row.full_name,
      email: row.email,
      role: row.role || "operator",
    }).catch((error) => ({
      ok: false,
      skipped: false,
      reason: error?.message || "hub_identity_sync_failed",
    }));

    if (result.ok) {
      synced += 1;
      continue;
    }

    skipped += 1;
    console.warn(`[${source}] skip ${row.email}: ${result.reason || "sync_failed"}`);
  }

  return { synced, skipped };
}

async function syncMl() {
  const rows = await runQuery(
    process.env.ML_DATABASE_URL || process.env.DATABASE_URL,
    `
      select
        e.tenant_global_id as tenant_id,
        e.nome as company_name,
        e.document_type,
        e.document_number,
        u.user_global_id as user_id,
        coalesce(nullif(u.nome, ''), u.email) as full_name,
        u.email,
        case
          when lower(coalesce(eu.papel, '')) in ('owner', 'admin') then 'owner'
          else 'operator'
        end as role
      from ml.empresas e
      join ml.empresa_usuarios eu on eu.empresa_id = e.id
      join ml.usuarios u on u.id = eu.usuario_id
      where e.tenant_global_id is not null
        and u.user_global_id is not null
        and coalesce(u.email, '') <> ''
    `,
  );

  return syncRows(rows, "ml");
}

async function syncShopee() {
  const rows = await runQuery(
    process.env.SHOPEE_DATABASE_URL || process.env.DATABASE_URL,
    `
      select
        a."tenantGlobalId" as tenant_id,
        a.name as company_name,
        a."documentType" as document_type,
        a."documentNumber" as document_number,
        u."userGlobalId" as user_id,
        coalesce(nullif(u.name, ''), u.email) as full_name,
        u.email,
        case
          when upper(coalesce(u.role::text, '')) in ('ADMIN', 'SUPER_ADMIN') then 'owner'
          else 'operator'
        end as role
      from "Account" a
      join "User" u on u."accountId" = a.id
      where a."tenantGlobalId" is not null
        and u."userGlobalId" is not null
        and coalesce(u.email, '') <> ''
    `,
  );

  return syncRows(rows, "shopee");
}

async function syncTracking() {
  const rows = await runQuery(
    process.env.AVANTRACKING_DATABASE_URL || process.env.DATABASE_URL,
    `
      select
        c."tenantGlobalId" as tenant_id,
        c.name as company_name,
        c."documentType" as document_type,
        c."documentNumber" as document_number,
        u."userGlobalId" as user_id,
        coalesce(nullif(u.name, ''), u.email) as full_name,
        u.email,
        case
          when upper(coalesce(u.role::text, '')) = 'ADMIN' then 'owner'
          else 'operator'
        end as role
      from "User" u
      join "Company" c on c.id = u."companyId"
      where c."tenantGlobalId" is not null
        and u."userGlobalId" is not null
        and coalesce(u.email, '') <> ''
    `,
  );

  return syncRows(rows, "tracking");
}

async function syncMadeira() {
  const rows = await runQuery(
    process.env.MAD_DATABASE_URL,
    `
      select
        w."tenantGlobalId" as tenant_id,
        w."sellerName" as company_name,
        w."documentType" as document_type,
        w."documentNumber" as document_number,
        u."userGlobalId" as user_id,
        coalesce(nullif(u.name, ''), u.email) as full_name,
        u.email,
        case
          when coalesce(u."isMaster", false) = true or lower(coalesce(u.role::text, '')) = 'admin' then 'owner'
          else 'operator'
        end as role
      from "MadUser" u
      join "MadWorkspace" w on w.id = u."workspaceId"
      where w."tenantGlobalId" is not null
        and u."userGlobalId" is not null
        and coalesce(u.email, '') <> ''
    `,
  );

  return syncRows(rows, "madeira");
}

async function main() {
  if (!isHubSyncConfigured()) {
    throw new Error("Configure HUB_BASE_URL e HUB_INTERNAL_TOKEN antes do backfill.");
  }

  const totals = {
    ml: await syncMl(),
    shopee: await syncShopee(),
    tracking: await syncTracking(),
    madeira: await syncMadeira(),
  };

  console.log(JSON.stringify(totals, null, 2));
}

main().catch((error) => {
  console.error("[backfill-hub-identities] erro:", error?.message || error);
  process.exit(1);
});
