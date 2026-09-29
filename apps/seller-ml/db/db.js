"use strict";

// PostgreSQL do seller-ml. Em producao, a URL precisa ser explicitamente a do
// modulo ML ou a DATABASE_URL compartilhada; nunca cai silenciosamente no banco Shopee.

const { Pool } = require("pg");

const RAW_DATABASE_URL = process.env.ML_DATABASE_URL || process.env.DATABASE_URL;

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
    "Banco do ML nao configurado. Defina ML_DATABASE_URL ou DATABASE_URL.",
  );
}

function envBoolean(name, fallback) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function resolveSslOptions(connectionString) {
  try {
    const parsed = new URL(connectionString);
    const sslMode = String(parsed.searchParams.get("sslmode") || "").toLowerCase();
    const sslFlag = String(parsed.searchParams.get("ssl") || "").toLowerCase();
    const neon = /\.neon\.(tech|build)$/i.test(parsed.hostname);

    if (sslMode === "disable" || sslFlag === "false") return false;

    const requiresTls =
      ["require", "verify-ca", "verify-full"].includes(sslMode) ||
      sslFlag === "true" ||
      neon;

    if (!requiresTls) return false;

    return {
      rejectUnauthorized: envBoolean(
        "ML_DB_SSL_REJECT_UNAUTHORIZED",
        true,
      ),
    };
  } catch (_error) {
    return false;
  }
}

function positiveInt(value, fallback, { min = 1, max = 1000000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

// =====================
// Helpers
// =====================
function safeSchemaName(input, fallback) {
  const s = String(input || "").trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) return fallback;
  return s;
}

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

  if (!dedup.includes("public")) dedup.push("public");
  const withoutPublic = dedup.filter((s) => s !== "public");
  return [...withoutPublic, "public"].join(", ");
}

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
  if (SEARCH_PATH_MODE === "public_first") return `public, ${schema}`;
  if (schema === "public") return "public";
  return `${schema}, public`;
}

const SEARCH_PATH = buildSearchPath();

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: resolveSslOptions(DATABASE_URL),
  max: positiveInt(process.env.ML_DB_POOL_MAX, 10, { min: 1, max: 50 }),
  idleTimeoutMillis: positiveInt(process.env.ML_DB_IDLE_TIMEOUT_MS, 30_000, {
    min: 1000,
    max: 10 * 60 * 1000,
  }),
  connectionTimeoutMillis: positiveInt(
    process.env.ML_DB_CONNECTION_TIMEOUT_MS,
    10_000,
    { min: 1000, max: 60_000 },
  ),
});

pool.on("error", (err) => {
  console.error("❌ [ML][DB] Postgres pool error:", err);
});

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
  _test: {
    normalizeDatabaseUrl,
    resolveSslOptions,
    sanitizeSearchPath,
  },
};
