"use strict";

const { Client } = require("pg");
const databaseUrl = process.env.DB_VOLTPRICE_DIRECT || process.env.VOLT_PRICE_DIRECT_DATABASE_URL;
if (!databaseUrl) process.exitCode = 1;

(async () => {
  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const migration = (await client.query("SELECT filename,applied_at FROM volt_price.migrations WHERE filename='005_cash_management.sql'" )).rows[0];
    const tables = (await client.query(`SELECT
      to_regclass('volt_price.bank_accounts')::text AS bank_accounts,
      to_regclass('volt_price.cash_recurrences')::text AS cash_recurrences,
      to_regclass('volt_price.cash_settlements')::text AS cash_settlements,
      to_regclass('volt_price.marketplace_receivables')::text AS marketplace_receivables`)).rows[0];
    const rls = (await client.query(`SELECT tablename,rowsecurity FROM pg_tables
      WHERE schemaname='volt_price' AND tablename IN ('bank_accounts','financial_categories','cost_centers','cash_recurrences','cash_settlements','marketplace_receivables')
      ORDER BY tablename`)).rows;
    console.log(JSON.stringify({ migration, tables, rls }, null, 2));
  } finally { await client.end(); }
})().catch((error) => { console.error("[VoltPrice] Verificacao de Cash falhou:", error.message); process.exit(1); });
