// db/migrate.js
"use strict";

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { Client } = require("pg");

function envBoolean(name, fallback) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function sslConfig(databaseUrl) {
  try {
    const parsed = new URL(String(databaseUrl || ""));
    const sslMode = String(parsed.searchParams.get("sslmode") || "").toLowerCase();
    const sslFlag = String(parsed.searchParams.get("ssl") || "").toLowerCase();
    const neon = /\.neon\.(tech|build)$/i.test(parsed.hostname);

    if (sslMode === "disable" || sslFlag === "false") return false;

    if (
      ["require", "verify-ca", "verify-full"].includes(sslMode) ||
      sslFlag === "true" ||
      neon
    ) {
      return {
        rejectUnauthorized: envBoolean("ML_DB_SSL_REJECT_UNAUTHORIZED", true),
      };
    }
  } catch (_error) {}
  return false;
}

async function ensureMigracoesTable(client) {
  await client.query(`
    create table if not exists migracoes (
      id bigserial primary key,
      arquivo text not null unique,
      aplicado_em timestamptz not null default now()
    );
  `);
}

async function consolidateSchemaMigrations(client) {
  await client.query(`
    do $$
    begin
      if exists (
        select 1
          from information_schema.tables
         where table_schema = 'public'
           and table_name = 'schema_migrations'
      ) then
        insert into ml.migracoes (arquivo, aplicado_em)
        select filename, coalesce(applied_at, now())
          from ml.schema_migrations
        on conflict (arquivo) do nothing;

        drop table ml.schema_migrations;
      end if;
    end $$;
  `);
}

async function alreadyApplied(client, arquivo) {
  const r = await client.query(
    "select 1 from ml.migracoes where arquivo = $1 limit 1",
    [arquivo],
  );
  return r.rowCount > 0;
}

async function markApplied(client, arquivo) {
  await client.query(
    "insert into ml.migracoes (arquivo) values ($1) on conflict do nothing",
    [arquivo],
  );
}

async function main() {
  const databaseUrl = process.env.ML_DATABASE_URL || process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error(
      "❌ ML_DATABASE_URL/DATABASE_URL não encontrado. Configure no .env ou no ambiente do serviço.",
    );
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    ssl: sslConfig(databaseUrl),
  });

  const migrationsDir = __dirname;
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d+_.*\.sql$/i.test(f))
    .sort((a, b) => a.localeCompare(b, "en"));

  if (files.length === 0) {
    console.log("⚠️ Nenhuma migração encontrada em /db (padrão: 001_nome.sql).");
    return;
  }

  await client.connect();

  try {
    await ensureMigracoesTable(client);
    await consolidateSchemaMigrations(client);

    console.log(`📦 Encontradas ${files.length} migrações.`);
    for (const file of files) {
      const full = path.join(migrationsDir, file);

      if (await alreadyApplied(client, file)) {
        console.log(`↩️  Pulando (já aplicada): ${file}`);
        continue;
      }

      const sql = fs.readFileSync(full, "utf8");
      console.log(`▶️  Aplicando: ${file}`);

      await client.query("begin");
      try {
        await client.query(sql);
        await markApplied(client, file);
        await client.query("commit");
        console.log(`✅ OK: ${file}`);
      } catch (e) {
        await client.query("rollback");
        console.error(`❌ Falhou: ${file}`);
        throw e;
      }
    }

    console.log("🎉 Migrações finalizadas com sucesso.");
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Erro nas migrações:", err.message);
    process.exit(1);
  });
}

module.exports = { main, sslConfig };
