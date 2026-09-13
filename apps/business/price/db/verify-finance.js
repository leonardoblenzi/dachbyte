"use strict";

const { Client } = require("pg");
const databaseUrl = process.env.DB_VOLTPRICE_DIRECT || process.env.VOLT_PRICE_DIRECT_DATABASE_URL;
if (!databaseUrl) process.exitCode = 1;

(async () => {
  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const migration = (await client.query("SELECT filename,applied_at FROM volt_price.migrations WHERE filename='004_financial_truth.sql'" )).rows[0];
    const tables = (await client.query(`SELECT
      to_regclass('volt_price.profit_components')::text AS profit_components,
      to_regclass('volt_price.profit_snapshot_items')::text AS profit_snapshot_items`)).rows[0];
    const columns = (await client.query(`SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema='volt_price' AND ((table_name='fee_snapshots' AND column_name IN ('version','components','total_amount','is_current'))
      OR (table_name='profit_snapshots' AND column_name IN ('order_id','version','calculation_type','components')))
      ORDER BY table_name,column_name`)).rows;
    console.log(JSON.stringify({ migration, tables, columns }, null, 2));
  } finally { await client.end(); }
})().catch((error) => { console.error("[VoltPrice] Verificacao financeira falhou:", error.message); process.exit(1); });
