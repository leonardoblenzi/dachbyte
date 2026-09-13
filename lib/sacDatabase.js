"use strict";

const { Pool } = require("pg");

function normalizeDatabaseUrl(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return "";

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

const DATABASE_URL = normalizeDatabaseUrl(process.env.DATABASE_URL);

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL nao definida para o SAC DACHBYTE.");
}

function wantsSsl(connectionString) {
  try {
    const parsed = new URL(connectionString);
    const sslMode = String(parsed.searchParams.get("sslmode") || "").toLowerCase();
    const sslFlag = String(parsed.searchParams.get("ssl") || "").toLowerCase();
    return (
      String(process.env.NODE_ENV || "").toLowerCase() === "production" ||
      sslMode === "require" ||
      sslMode === "prefer" ||
      sslMode === "verify-ca" ||
      sslMode === "verify-full" ||
      sslFlag === "true" ||
      /\.neon\.(tech|build)$/i.test(parsed.hostname)
    );
  } catch (_error) {
    return String(process.env.NODE_ENV || "").toLowerCase() === "production";
  }
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: wantsSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (error) => {
  console.error("[SAC][DB] Postgres pool error:", error);
});

function query(text, params) {
  return pool.query(text, params);
}

module.exports = {
  pool,
  query,
};
