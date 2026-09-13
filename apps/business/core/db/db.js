"use strict";

const { AsyncLocalStorage } = require("async_hooks");
const { Pool } = require("pg");
const logger = require("../src/observability/logger");
const metrics = require("../src/observability/metrics");

const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const DATABASE_URL = process.env.VOLT_CORE_APP_DATABASE_URL
  || (!isProd ? (process.env.VOLT_CORE_DATABASE_URL || process.env.DATABASE_URL) : "");
const tenantStorage = new AsyncLocalStorage();

function wantsSsl(databaseUrl) {
  if (/sslmode=disable(?:&|$)/i.test(String(databaseUrl || ""))) return false;
  return isProd || /sslmode=require/i.test(databaseUrl || "");
}

function createPool() {
  if (!DATABASE_URL) return null;
  return new Pool({
    connectionString: DATABASE_URL,
    ssl: wantsSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false,
    max: Number(process.env.VOLT_CORE_DB_POOL_MAX || 8),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

const pool = createPool();
if (pool) pool.on("error", (err) => logger.error("db.pool_error", { error: err }));


function summarizeSql(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const operation = (normalized.match(/^(select|insert|update|delete|begin|commit|rollback|with|alter|create|drop)/i) || [])[1]?.toLowerCase() || "query";
  const table = (normalized.match(/(?:from|into|update|join)\s+([a-zA-Z0-9_."]+)/i) || [])[1]?.replace(/"/g, "") || undefined;
  return { operation, table };
}

async function observedQuery(client, text, params) {
  const started = process.hrtime.bigint();
  const threshold = Number(process.env.VOLT_CORE_SLOW_QUERY_MS || 750);
  const summary = summarizeSql(text);
  try {
    const result = await client.query(text, params);
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    metrics.recordDatabaseQuery(durationMs, { slowThresholdMs: threshold });
    if (durationMs >= threshold && !["begin", "commit", "rollback"].includes(summary.operation)) {
      logger.warn("db.query.slow", { ...summary, durationMs: Number(durationMs.toFixed(2)), rowCount: result?.rowCount });
    }
    return result;
  } catch (error) {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    metrics.recordDatabaseQuery(durationMs, { error: true, slowThresholdMs: threshold });
    logger.error("db.query.error", { ...summary, durationMs: Number(durationMs.toFixed(2)), errorCode: error?.code, error });
    throw error;
  }
}

function observedClient(client) {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "query") return (text, params) => observedQuery(target, text, params);
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function isDatabaseEnabled() { return Boolean(pool); }
function currentTenantContext() { return tenantStorage.getStore() || null; }
function withTenantContext(companyId, fn) {
  const normalizedCompanyId = String(companyId || "").trim();
  if (!normalizedCompanyId) {
    const error = new Error("Tenant obrigatorio para contexto de banco.");
    error.code = "TENANT_CONTEXT_REQUIRED";
    throw error;
  }
  return tenantStorage.run({ companyId: normalizedCompanyId, bypassRls: false }, fn);
}
function withRlsBypass(fn) { return tenantStorage.run({ companyId: "", bypassRls: true }, fn); }

function resolveRlsContext(context = currentTenantContext()) {
  return {
    companyId: String(context?.companyId || "").trim(),
    bypassRls: context?.bypassRls === true,
  };
}

async function applyRlsContext(client) {
  const context = resolveRlsContext();
  await client.query(
    "select set_config('volt_core.company_id', $1, false), set_config('volt_core.bypass_rls', $2, false)",
    [context.companyId, context.bypassRls ? "on" : "off"],
  );
}

async function clearRlsContext(client) {
  await client.query(
    "select set_config('volt_core.company_id', '', false), set_config('volt_core.bypass_rls', 'off', false)",
  ).catch(() => {});
}

async function assertApplicationRoleSecurity() {
  if (!pool) return { ok: true, skipped: true };
  const client = await pool.connect();
  try {
    const roleResult = await client.query(`
      select current_user as role_name,
             coalesce((select rolbypassrls from pg_roles where rolname = current_user), false) as bypass_rls,
             coalesce((select rolsuper from pg_roles where rolname = current_user), false) as superuser,
             case
               when exists (select 1 from pg_roles where rolname = 'neon_superuser')
               then pg_has_role(current_user, 'neon_superuser', 'member')
               else false
             end as neon_superuser_member;
    `);
    const role = roleResult.rows[0] || {};
    if (role.bypass_rls === true || role.superuser === true || role.neon_superuser_member === true) {
      const error = new Error(`A role da aplicacao (${role.role_name || "desconhecida"}) nao pode possuir SUPERUSER/BYPASSRLS nem herdar neon_superuser.`);
      error.code = "APP_DATABASE_ROLE_BYPASSES_RLS";
      throw error;
    }

    const rlsResult = await client.query(`
      select count(*)::int as protected_count
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'volt_core'
         and c.relname in ('customers','sales','cash_sessions','workflow_events','integration_jobs','integration_outbox_events','integration_webhook_events','company_product_subscriptions','service_usage_counters','entity_extension_data','stock_reservations')
         and c.relrowsecurity = true
         and c.relforcerowsecurity = true;
    `);
    if (Number(rlsResult.rows[0]?.protected_count || 0) < 11) {
      const error = new Error("RLS/FORCE RLS nao esta ativo nas tabelas criticas do Volt Core.");
      error.code = "RLS_NOT_FULLY_ENABLED";
      throw error;
    }

    return { ok: true, role: role.role_name };
  } finally {
    client.release();
  }
}

async function query(text, params) {
  if (!pool) {
    const error = new Error("VOLT_CORE_APP_DATABASE_URL nao configurada.");
    error.code = "VOLT_CORE_DATABASE_URL_MISSING";
    throw error;
  }
  const client = await pool.connect();
  try {
    await applyRlsContext(client);
    return await observedQuery(client, text, params);
  } finally {
    await clearRlsContext(client);
    client.release();
  }
}

async function withClient(fn) {
  if (!pool) {
    const error = new Error("VOLT_CORE_APP_DATABASE_URL nao configurada.");
    error.code = "VOLT_CORE_DATABASE_URL_MISSING";
    throw error;
  }
  const client = await pool.connect();
  try {
    await applyRlsContext(client);
    return await fn(observedClient(client));
  } finally {
    await clearRlsContext(client);
    client.release();
  }
}

module.exports = {
  DATABASE_URL,
  assertApplicationRoleSecurity,
  currentTenantContext,
  isDatabaseEnabled,
  pool,
  query,
  resolveRlsContext,
  withClient,
  withRlsBypass,
  withTenantContext,
  observedQuery,
  summarizeSql,
};
