"use strict";

// ml/db/db.js
// Conexão Postgres (Render) respeitando schema do ML (ml) + fallback public.

const { Pool } = require("pg");

// Prioriza ML_DATABASE_URL; caso contrario usa a mesma URL SQL da Shopee/suite.
const RAW_DATABASE_URL =
  process.env.ML_DATABASE_URL ||
  process.env.SHOPEE_DATABASE_URL ||
  process.env.DATABASE_URL;

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

const DATABASE_URL = normalizeDatabaseUrl(RAW_DATABASE_URL);
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL nao definida. Configure ML_DATABASE_URL/DATABASE_URL/SHOPEE_DATABASE_URL no Render (Environment).",
  );
}

const isProd =
  String(process.env.NODE_ENV || "").toLowerCase() === "production";

function resolveSslOptions(connectionString) {
  try {
    const parsed = new URL(connectionString);
    const sslMode = String(parsed.searchParams.get("sslmode") || "").toLowerCase();
    const sslFlag = String(parsed.searchParams.get("ssl") || "").toLowerCase();

    if (
      isProd ||
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
    return isProd ? { rejectUnauthorized: false } : false;
  }

  return false;
}

// =====================
// Helpers
// =====================
function safeSchemaName(input, fallback) {
  const s = String(input || "").trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) return fallback;
  return s;
}

// Ex.: ...?sslmode=require&options=-c%20search_path=ml,public
function extractSearchPathFromUrl(connString) {
  try {
    const u = new URL(connString);

    const direct = u.searchParams.get("search_path");
    if (direct) return String(direct).trim() || null;

    const opts = u.searchParams.get("options");
    if (!opts) return null;

    const decoded = decodeURIComponent(String(opts).replace(/\+/g, "%20"));
    const m = decoded.match(/search_path\s*=\s*([^\s]+)/i);
    return m ? String(m[1]).trim() : null;
  } catch {
    return null;
  }
}

function sanitizeSearchPath(raw) {
  const list = String(raw || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => safeSchemaName(x, null))
    .filter(Boolean);

  if (!list.length) return null;

  const dedup = [];
  for (const s of list) if (!dedup.includes(s)) dedup.push(s);

  // garante public no fim
  if (!dedup.includes("public")) dedup.push("public");
  const withoutPublic = dedup.filter((s) => s !== "public");
  return [...withoutPublic, "public"].join(", ");
}

// =====================
// Resolve search_path
// =====================
const ML_DB_SCHEMA = safeSchemaName(process.env.ML_DB_SCHEMA, "ml");

const URL_SP_RAW = extractSearchPathFromUrl(DATABASE_URL);
const ENV_SP_RAW = process.env.ML_DB_SEARCH_PATH;

const EXPLICIT_SP = sanitizeSearchPath(ENV_SP_RAW || URL_SP_RAW);

const SEARCH_PATH_MODE = String(
  process.env.ML_DB_SEARCH_PATH_MODE || "ml_first",
)
  .trim()
  .toLowerCase();

function buildSearchPath() {
  if (EXPLICIT_SP) return EXPLICIT_SP;

  const schema = safeSchemaName(ML_DB_SCHEMA, "ml");

  if (SEARCH_PATH_MODE === "public_first") {
    return `public, ${schema}`;
  }

  if (schema === "public") return "public";
  return `${schema}, public`;
}

const SEARCH_PATH = buildSearchPath();

// =====================
// Pool
// =====================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: resolveSslOptions(DATABASE_URL),
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) => {
  console.error("❌ [ML][DB] Postgres pool error:", err);
});

// ✅ garante search_path em toda conexão
pool.on("connect", async (client) => {
  try {
    await client.query(`set search_path to ${SEARCH_PATH};`);
  } catch (e) {
    console.error(
      "❌ [ML][DB] Falha ao aplicar search_path:",
      SEARCH_PATH,
      e?.message || e,
    );
  }
});

// =====================
// Exports
// =====================
async function query(text, params) {
  return pool.query(text, params);
}

async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query,
  withClient,
  SEARCH_PATH,
  ML_DB_SCHEMA,
};
