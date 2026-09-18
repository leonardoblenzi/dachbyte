"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const databaseUrl = String(process.env.DATABASE_URL || "").trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required to migrate DACH Ads");

const migrationsDir = path.resolve(__dirname, "..", "..", "db");
const appRole = String(process.env.ADS_APP_DB_ROLE || "dachbyte_ads_app").trim();
const workerRole = String(process.env.ADS_WORKER_DB_ROLE || "dachbyte_ads_worker").trim();

function quoteIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid PostgreSQL identifier: ${value}`);
  }
  return `"${value}"`;
}

async function grantRuntimePrivileges(client) {
  for (const role of [appRole, workerRole]) {
    const quoted = quoteIdentifier(role);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${quoted}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quoted}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoted}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quoted}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${quoted}`);
  }
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => /^\d+_.+\.sql$/.test(file))
      .sort();

    for (const filename of files) {
      const already = await client.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [filename],
      );
      if (already.rowCount) continue;

      const sql = fs.readFileSync(path.join(migrationsDir, filename), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(filename) VALUES ($1)", [filename]);
        await client.query("COMMIT");
        console.log(`[dach-ads:migrate] applied ${filename}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    await grantRuntimePrivileges(client);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("[dach-ads:migrate] failed", error);
  process.exit(1);
});
