"use strict";

const { Client } = require("pg");

const databaseUrl = process.env.DB_VOLTPRICE_DIRECT || process.env.VOLT_PRICE_DIRECT_DATABASE_URL;
if (!databaseUrl) {
  console.error("[VoltPrice] DB_VOLTPRICE_DIRECT/VOLT_PRICE_DIRECT_DATABASE_URL nao configurada.");
  process.exit(1);
}

async function main() {
  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const migrations = await client.query("SELECT filename,applied_at FROM volt_price.migrations ORDER BY filename");
    const schema = await client.query(`
      SELECT to_regclass('volt_price.sync_runs')::text AS sync_runs,
             to_regclass('volt_price.sync_checkpoints')::text AS sync_checkpoints,
             to_regclass('volt_price.fee_snapshots')::text AS fee_snapshots,
             to_regclass('volt_price.profit_snapshots')::text AS profit_snapshots
    `);
    console.log(JSON.stringify({ migrations: migrations.rows, schema: schema.rows[0] }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("[VoltPrice] Verificacao falhou:", error.message);
  process.exit(1);
});
