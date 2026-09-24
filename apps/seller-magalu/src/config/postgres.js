"use strict";

const { Pool } = require("pg");
const env = require("./env");

let pool;

function resolveSsl(connectionString) {
  try {
    const parsed = new URL(connectionString);
    const mode = String(parsed.searchParams.get("sslmode") || "").toLowerCase();
    if (["require", "prefer", "verify-ca", "verify-full"].includes(mode)) {
      return { rejectUnauthorized: false };
    }
    if (/\.neon\.(tech|build)$/i.test(parsed.hostname)) {
      return { rejectUnauthorized: false };
    }
  } catch (_error) {}
  return undefined;
}

function getPool() {
  if (!env.MAGALU_DATABASE_URL) {
    throw new Error("MAGALU_DATABASE_URL/DATABASE_URL não configurada para seller-magalu.");
  }
  if (!pool) {
    pool = new Pool({
      connectionString: env.MAGALU_DATABASE_URL,
      ssl: resolveSsl(env.MAGALU_DATABASE_URL),
      max: 10,
      application_name: "dachbyte-seller-magalu",
    });
  }
  return pool;
}

async function query(text, params = []) {
  return getPool().query(text, params);
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

module.exports = { getPool, query, queryOne, withClient };
