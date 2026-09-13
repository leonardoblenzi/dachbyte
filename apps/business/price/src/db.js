"use strict";

const { Pool } = require("pg");
const { config } = require("./config");

function wantsSsl(url) {
  if (/sslmode=disable(?:&|$)/i.test(String(url || ""))) return false;
  return config.isProduction || /sslmode=require/i.test(String(url || ""));
}

const pool = config.databaseUrl
  ? new Pool({
      connectionString: config.databaseUrl,
      ssl: wantsSsl(config.databaseUrl) ? { rejectUnauthorized: false } : false,
      max: Number(process.env.VOLT_PRICE_DB_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
  : null;

if (pool) {
  pool.on("error", (error) => console.error("[volt-price][db]", error));
}

function ensurePool() {
  if (!pool) {
    const error = new Error("DB_VOLTPRICE/VOLT_PRICE_DATABASE_URL/DATABASE_URL nao configurada.");
    error.code = "database_not_configured";
    error.statusCode = 503;
    throw error;
  }
  return pool;
}

async function query(text, params = []) {
  return ensurePool().query(text, params);
}

async function withClient(handler) {
  const client = await ensurePool().connect();
  try { return await handler(client); } finally { client.release(); }
}

async function withTenant(tenantId, userId, handler) {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.vp_tenant_id', $1, true)", [String(tenantId)]);
      await client.query("SELECT set_config('app.vp_user_id', $1, true)", [String(userId || "")]);
      await client.query("SELECT set_config('app.vp_platform_admin', 'false', true)");
      const result = await handler(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
}

async function withPlatformAdmin(userId, handler) {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.vp_user_id', $1, true)", [String(userId || "")]);
      await client.query("SELECT set_config('app.vp_platform_admin', 'true', true)");
      const result = await handler(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
}

module.exports = { pool, query, withClient, withTenant, withPlatformAdmin, ensurePool };
