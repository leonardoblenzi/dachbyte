"use strict";

require("../src/loadEnv").loadLocalEnv();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const runtimeDatabaseUrl = process.env.DB_VOLTPRICE
  || process.env.VOLT_PRICE_DATABASE_URL
  || process.env.DATABASE_URL
  || "";
const directDatabaseUrl = process.env.DB_VOLTPRICE_DIRECT
  || process.env.VOLT_PRICE_DIRECT_DATABASE_URL
  || (!isProduction ? runtimeDatabaseUrl : "");

if (!directDatabaseUrl) {
  console.error("[VoltPrice] DB_VOLTPRICE_DIRECT/VOLT_PRICE_DIRECT_DATABASE_URL nao configurada para migrations.");
  process.exit(1);
}

function wantsSsl(url) {
  if (/sslmode=disable(?:&|$)/i.test(String(url || ""))) return false;
  return /sslmode=require|sslmode=verify-full/i.test(String(url || ""));
}

function parseIdentity(url) {
  if (!url) return null;
  const parsed = new URL(url);
  return {
    user: decodeURIComponent(parsed.username || "").trim(),
    database: decodeURIComponent(String(parsed.pathname || "").replace(/^\//, "")),
  };
}

function quoteIdentifier(value) {
  return `"${String(value || "").replace(/"/g, '""')}"`;
}

async function ensureRuntimePrivileges(client) {
  if (!runtimeDatabaseUrl) {
    if (isProduction) throw new Error("DB_VOLTPRICE e obrigatoria em producao para validar a role runtime.");
    return;
  }

  const runtime = parseIdentity(runtimeDatabaseUrl);
  const migration = parseIdentity(directDatabaseUrl);
  if (!runtime?.user) throw new Error("DB_VOLTPRICE deve informar o usuario explicitamente.");
  if (isProduction && runtime.user === migration?.user) {
    throw new Error("A role runtime do VoltPrice deve ser diferente da role usada nas migrations.");
  }

  const roleResult = await client.query(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
    [runtime.user],
  );
  if (!roleResult.rowCount) {
    throw new Error(`Role runtime do VoltPrice nao existe: ${runtime.user}. Execute o provisionamento PostgreSQL primeiro.`);
  }
  if (roleResult.rows[0].rolsuper === true || roleResult.rows[0].rolbypassrls === true) {
    throw new Error(`Role runtime do VoltPrice insegura: ${runtime.user} possui SUPERUSER ou BYPASSRLS.`);
  }

  const role = quoteIdentifier(runtime.user);
  const database = quoteIdentifier(runtime.database);
  await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
  await client.query(`REVOKE CREATE ON SCHEMA volt_price FROM ${role}`);
  await client.query(`GRANT USAGE ON SCHEMA volt_price TO ${role}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA volt_price TO ${role}`);
  await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA volt_price TO ${role}`);
  await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA volt_price TO ${role}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA volt_price GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA volt_price GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA volt_price GRANT EXECUTE ON FUNCTIONS TO ${role}`);
}

async function main() {
  const client = new Client({
    connectionString: directDatabaseUrl,
    ssl: wantsSsl(directDatabaseUrl) ? { rejectUnauthorized: false } : false,
  });

  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('volt_price_migrations'))");
    await client.query("CREATE SCHEMA IF NOT EXISTS volt_price");
    await client.query(`
      CREATE TABLE IF NOT EXISTS volt_price.migrations (
        id bigserial primary key,
        filename text not null unique,
        checksum text,
        applied_at timestamptz not null default now()
      )
    `);

    const files = fs
      .readdirSync(__dirname)
      .filter((file) => /^\d+_.*\.sql$/i.test(file))
      .sort();

    for (const file of files) {
      const sqlText = fs.readFileSync(path.join(__dirname, file), "utf8").replace(/\r\n/g, "\n");
      const checksum = crypto.createHash("sha256").update(sqlText).digest("hex");
      const previous = (
        await client.query("SELECT checksum FROM volt_price.migrations WHERE filename=$1", [file])
      ).rows[0];

      if (previous) {
        if (previous.checksum && previous.checksum !== checksum) {
          throw new Error(`Migration VoltPrice alterada depois de aplicada: ${file}`);
        }
        continue;
      }

      console.log(`[VoltPrice] Aplicando ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sqlText);
        await client.query(
          "INSERT INTO volt_price.migrations(filename,checksum) VALUES($1,$2)",
          [file, checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    await ensureRuntimePrivileges(client);
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('volt_price_migrations'))").catch(() => {});
    await client.end();
  }
}

main().catch((error) => {
  console.error("[VoltPrice] Migration falhou:", error);
  process.exit(1);
});
