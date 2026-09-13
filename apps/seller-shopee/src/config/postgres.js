"use strict";

const { Pool } = require("pg");
const env = require("./env");

let pool;

function normalizeDatabaseUrl(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return null;
  }

  try {
    const connectionUrl = new URL(value);

    if (
      process.platform === "win32" &&
      connectionUrl.searchParams.get("channel_binding") === "require"
    ) {
      connectionUrl.searchParams.set("channel_binding", "disable");
    }

    if (
      connectionUrl.searchParams.get("sslmode") === "require" &&
      !connectionUrl.searchParams.has("uselibpqcompat")
    ) {
      connectionUrl.searchParams.set("uselibpqcompat", "true");
    }

    return connectionUrl.toString();
  } catch (_error) {
    return value;
  }
}

function resolveSslOptions(connectionString) {
  try {
    const parsed = new URL(connectionString);
    const sslMode = String(parsed.searchParams.get("sslmode") || "").toLowerCase();
    const sslFlag = String(parsed.searchParams.get("ssl") || "").toLowerCase();

    if (
      sslMode === "require" ||
      sslMode === "prefer" ||
      sslMode === "verify-ca" ||
      sslMode === "verify-full" ||
      sslFlag === "true" ||
      /\.neon\.(tech|build)$/i.test(parsed.hostname)
    ) {
      return { rejectUnauthorized: false };
    }
  } catch (_error) {
    return undefined;
  }

  return undefined;
}

function getPool() {
  const connectionString = normalizeDatabaseUrl(env.SHOPEE_DATABASE_URL || env.DATABASE_URL);

  if (!connectionString) {
    throw new Error("SHOPEE_DATABASE_URL ou DATABASE_URL nao configurada para acesso SQL direto.");
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl: resolveSslOptions(connectionString),
      max: 10,
    });
  }

  return pool;
}

async function query(text, params = []) {
  try {
    return await getPool().query(text, params);
  } catch (error) {
    const compactSql = String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400);
    const paramTypes = Array.isArray(params)
      ? params.map((value) => (value == null ? "null" : typeof value))
      : [];
    const paramPreview = Array.isArray(params)
      ? params.slice(0, 8).map((value) => {
          if (value == null) return null;
          const text = String(value);
          return text.length > 80 ? `${text.slice(0, 77)}...` : text;
        })
      : [];

    console.error("[postgres.query] SQL error", {
      code: error?.code || null,
      message: error?.message || null,
      detail: error?.detail || null,
      sql: compactSql,
      paramTypes,
      paramPreview,
      paramCount: Array.isArray(params) ? params.length : 0,
    });

    throw error;
  }
}

async function queryOne(text, params = []) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

async function withClient(callback) {
  const client = await getPool().connect();

  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

module.exports = {
  getPool,
  query,
  queryOne,
  withClient,
};
