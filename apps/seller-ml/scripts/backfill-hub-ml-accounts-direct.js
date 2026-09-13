"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { loadRuntimeEnv } = require("../../../lib/runtimeEnv");

loadRuntimeEnv({
  defaultCandidates: [
    path.join(__dirname, "..", ".env"),
    path.join(__dirname, "..", "..", ".env"),
  ],
});

const mlDb = require("../db/db");

function parseArgs(argv) {
  const args = {};
  for (const part of argv) {
    const raw = String(part || "");
    if (raw.startsWith("--") && raw.includes("=")) {
      const index = raw.indexOf("=");
      args[raw.slice(2, index)] = raw.slice(index + 1);
    } else if (raw.startsWith("--")) {
      args[raw.slice(2)] = true;
    }
  }
  return args;
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return Object.fromEntries(
    fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
        return [key, value];
      }),
  );
}

function normalizeLimit(value) {
  const parsed = Math.trunc(Number(value || 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeAccountIds(value) {
  return String(value || "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function hubDatabaseUrl() {
  if (process.env.HUB_NEON_DATABASE_URL) return process.env.HUB_NEON_DATABASE_URL;
  if (process.env.NEON_DATABASE_URL) return process.env.NEON_DATABASE_URL;
  const hubVars = parseEnvFile(path.join(__dirname, "..", "..", "..", "hub pagamento", ".dev.vars"));
  return hubVars.NEON_DATABASE_URL || "";
}

function resourceKey(accountId) {
  return `ml:${String(accountId || "").trim()}`;
}

async function markLegacyAccountsUnlimited({ dryRun }) {
  if (dryRun) {
    const result = await mlDb.query(`
      select count(*)::int as total
        from meli_contas
       where billing_status = 'legacy_active'
         and billing_mode = 'legacy'
    `);
    return Number(result.rows[0]?.total || 0);
  }

  const result = await mlDb.query(`
    update meli_contas
       set billing_status = 'legacy_active',
           billing_mode = 'legacy',
           usage_policy = 'unlimited',
           range_enforcement = false,
           plan_code = null,
           order_range_code = null,
           billing_updated_at = now()
     where billing_status = 'legacy_active'
       and billing_mode = 'legacy'
  `);
  return result.rowCount || 0;
}

async function loadAccounts({ accountIds, limit }) {
  const params = [];
  const filters = [];
  if (accountIds.length) {
    params.push(accountIds);
    filters.push(`mc.id = any($${params.length}::bigint[])`);
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";
  const limitSql = limit ? `limit ${Number(limit)}` : "";
  const result = await mlDb.query(`
    select
      mc.id,
      mc.empresa_id,
      mc.meli_user_id::text as meli_user_id,
      coalesce(nullif(mc.apelido, ''), 'Conta ' || mc.meli_user_id::text) as apelido,
      mc.billing_status,
      mc.billing_mode,
      mc.usage_policy,
      mc.range_enforcement,
      mc.plan_code,
      mc.order_range_code,
      e.nome as empresa_nome,
      e.tenant_global_id,
      e.document_type,
      e.document_number,
      u.user_global_id,
      u.nome as usuario_nome,
      u.email as usuario_email,
      eu.papel as usuario_papel
    from meli_contas mc
    join empresas e on e.id = mc.empresa_id
    left join lateral (
      select eu.usuario_id, eu.papel
        from empresa_usuarios eu
       where eu.empresa_id = mc.empresa_id
       order by case eu.papel when 'owner' then 0 when 'admin' then 1 else 2 end, eu.criado_em asc
       limit 1
    ) eu on true
    left join usuarios u on u.id = eu.usuario_id
    ${where}
    order by e.nome asc, mc.id asc
    ${limitSql}
  `, params);
  return result.rows || [];
}

async function syncIdentity(client, row) {
  const tenantId = String(row.tenant_global_id || "").trim();
  const userId = String(row.user_global_id || "").trim();
  const email = String(row.usuario_email || "").trim().toLowerCase();
  if (!tenantId || !userId || !email) return false;

  await client.query(
    `insert into tenants (tenant_id, company_name, document_type, document_number, status, updated_at)
     values ($1, $2, $3, $4, 'active', now())
     on conflict (tenant_id) do update set
       company_name = coalesce(nullif(trim(tenants.company_name), ''), excluded.company_name),
       document_type = coalesce(tenants.document_type, excluded.document_type),
       document_number = coalesce(tenants.document_number, excluded.document_number),
       updated_at = now()`,
    [
      tenantId,
      String(row.empresa_nome || `Empresa ${row.empresa_id}`).trim(),
      row.document_type || null,
      row.document_number || null,
    ],
  );

  await client.query(
    `insert into hub_users (user_id, full_name, email, updated_at)
     values ($1, $2, $3, now())
     on conflict (user_id) do update set
       full_name = coalesce(nullif(trim(hub_users.full_name), ''), excluded.full_name),
       email = coalesce(nullif(trim(hub_users.email), ''), excluded.email),
       updated_at = now()`,
    [userId, String(row.usuario_nome || email).trim(), email],
  );

  await client.query(
    `insert into tenant_users (tenant_id, user_id, role, updated_at)
     values ($1, $2, $3, now())
     on conflict (tenant_id, user_id) do update set
       role = excluded.role,
       updated_at = now()`,
    [tenantId, userId, row.usuario_papel || "owner"],
  );
  return true;
}

async function syncAccount(client, row) {
  const tenantId = String(row.tenant_global_id || `ml_empresa_${row.empresa_id}`).trim();
  const accountId = String(row.meli_user_id || "").trim();
  const label = `${String(row.empresa_nome || `Empresa ${row.empresa_id}`).trim()} - ${String(row.apelido || accountId).trim()}`;
  const status = row.billing_status || "legacy_active";
  const billingMode = row.billing_mode || "legacy";
  const usagePolicy = row.usage_policy || "unlimited";
  const key = resourceKey(accountId);

  await client.query(
    `insert into billing_resources
      (resource_key, tenant_id, module_slug, external_account_id, label, status,
       billing_mode, usage_policy, range_enforcement, plan_code, order_range_code, metadata_json, updated_at)
     values ($1, $2, 'ml', $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, now())
     on conflict (resource_key) do update set
       tenant_id = excluded.tenant_id,
       label = excluded.label,
       status = case
         when billing_resources.status in ('active', 'courtesy_unlimited', 'internal_unlimited', 'suspended_by_payment', 'suspended_by_range', 'range_exceeded') then billing_resources.status
         else excluded.status
       end,
       billing_mode = case
         when billing_resources.billing_mode in ('paid', 'courtesy', 'internal') then billing_resources.billing_mode
         else excluded.billing_mode
       end,
       usage_policy = case
         when billing_resources.usage_policy = 'unlimited' then billing_resources.usage_policy
         else excluded.usage_policy
       end,
       range_enforcement = billing_resources.range_enforcement or excluded.range_enforcement,
       plan_code = coalesce(billing_resources.plan_code, excluded.plan_code),
       order_range_code = coalesce(billing_resources.order_range_code, excluded.order_range_code),
       metadata_json = billing_resources.metadata_json || excluded.metadata_json,
       updated_at = now()`,
    [
      key,
      tenantId,
      accountId,
      label,
      status,
      billingMode,
      usagePolicy,
      Boolean(row.range_enforcement),
      row.plan_code || null,
      row.order_range_code || null,
      JSON.stringify({
        source: "ml_direct_backfill",
        ml_local_account_id: row.id,
        ml_empresa_id: row.empresa_id,
        ml_account_label: row.apelido || null,
      }),
    ],
  );

  await client.query(
    `insert into credit_wallets (resource_key, unlimited, updated_at)
     values ($1, $2, now())
     on conflict (resource_key) do update set
       unlimited = credit_wallets.unlimited or excluded.unlimited,
       updated_at = now()`,
    [key, usagePolicy === "unlimited" || billingMode === "legacy" || status === "legacy_active"],
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args["dry-run"]);
  const accountIds = normalizeAccountIds(args.accounts);
  const limit = normalizeLimit(args.limit);
  const databaseUrl = hubDatabaseUrl();
  if (!databaseUrl) throw new Error("HUB_NEON_DATABASE_URL/NEON_DATABASE_URL nao encontrado para o Hub.");

  console.log("[Hub ML Accounts Direct] Iniciando", JSON.stringify({
    dryRun,
    accounts: accountIds.length ? accountIds : "all",
    limit: limit || "none",
  }));

  const migrated = await markLegacyAccountsUnlimited({ dryRun });
  const accounts = await loadAccounts({ accountIds, limit });
  console.log(`[Hub ML Accounts Direct] Contas legado ${dryRun ? "que seriam marcadas" : "marcadas"} como ilimitadas: ${migrated}`);
  console.log(`[Hub ML Accounts Direct] Contas carregadas: ${accounts.length}`);

  if (dryRun) {
    accounts.slice(0, 10).forEach((row) => {
      console.log("[dry-run]", JSON.stringify({
        tenant_id: row.tenant_global_id,
        account_id: row.meli_user_id,
        status: row.billing_status,
        billing_mode: row.billing_mode,
        usage_policy: row.usage_policy,
      }));
    });
    return;
  }

  const hubPool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("sslmode=") || databaseUrl.includes("neon.tech")
      ? { rejectUnauthorized: false }
      : undefined,
  });

  let identities = 0;
  let synced = 0;
  const client = await hubPool.connect();
  try {
    await client.query("begin");
    for (const row of accounts) {
      if (await syncIdentity(client, row)) identities += 1;
      await syncAccount(client, row);
      synced += 1;
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
    await hubPool.end().catch(() => {});
  }

  console.log(JSON.stringify({ ok: true, identities, synced, migrated_unlimited: migrated }, null, 2));
}

main()
  .catch((error) => {
    console.error("[Hub ML Accounts Direct] Falhou:", error?.message || error);
    process.exit(1);
  })
  .finally(async () => {
    if (mlDb.pool && typeof mlDb.pool.end === "function") {
      await mlDb.pool.end().catch(() => {});
    }
  });
