"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch (_error) {
  // dotenv is optional in production.
}

const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const databaseUrl = process.env.VOLT_CORE_MIGRATION_DATABASE_URL
  || process.env.VOLT_CORE_DIRECT_DATABASE_URL
  || (!isProd ? (process.env.VOLT_CORE_DATABASE_URL || process.env.DATABASE_URL) : "");
const appDatabaseUrl = process.env.VOLT_CORE_APP_DATABASE_URL || "";

function wantsSsl(url) {
  if (/sslmode=disable(?:&|$)/i.test(String(url || ""))) return false;
  return isProd || /sslmode=require/i.test(url || "");
}

function quoteIdentifier(value) {
  return `"${String(value || "").replace(/"/g, '""')}"`;
}

function quoteLiteral(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function parseDatabaseIdentity(url) {
  if (!url) return null;
  const parsed = new URL(url);
  return {
    user: decodeURIComponent(parsed.username || "").trim(),
    password: decodeURIComponent(parsed.password || ""),
    database: decodeURIComponent(String(parsed.pathname || "").replace(/^\//, "")),
  };
}

async function ensureApplicationRole(client) {
  if (!appDatabaseUrl) {
    if (isProd) throw new Error("VOLT_CORE_APP_DATABASE_URL e obrigatoria em producao para provisionar a role NOBYPASSRLS.");
    return { skipped: true };
  }

  const app = parseDatabaseIdentity(appDatabaseUrl);
  const migration = parseDatabaseIdentity(databaseUrl);
  if (!app?.user || !app.password) {
    throw new Error("VOLT_CORE_APP_DATABASE_URL deve conter usuario e senha da role exclusiva da aplicacao.");
  }
  if (migration?.user && app.user === migration.user) {
    throw new Error("A role da aplicacao nao pode ser a mesma role usada nas migrations.");
  }

  const roleName = quoteIdentifier(app.user);
  const rolePassword = quoteLiteral(app.password);
  const roleExists = await client.query(
    "select rolsuper, rolbypassrls from pg_roles where rolname = $1",
    [app.user],
  );
  if (!roleExists.rowCount) {
    await client.query(`CREATE ROLE ${roleName} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${rolePassword}`);
    console.log(`[Volt Core] Role de aplicacao criada: ${app.user}`);
  } else {
    const existingRole = roleExists.rows[0];
    if (existingRole.rolsuper === true || existingRole.rolbypassrls === true) {
      throw new Error(`A role ${app.user} possui SUPERUSER ou BYPASSRLS e precisa ser corrigida por um administrador do banco.`);
    }
    await client.query(`ALTER ROLE ${roleName} LOGIN NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${rolePassword}`);
    console.log(`[Volt Core] Role de aplicacao endurecida: ${app.user}`);
  }

  const neonSuperuser = await client.query("select 1 from pg_roles where rolname = 'neon_superuser'");
  if (neonSuperuser.rowCount) {
    const membership = await client.query("select pg_has_role($1, 'neon_superuser', 'member') as member", [app.user]);
    if (membership.rows[0]?.member === true) {
      await client.query(`REVOKE neon_superuser FROM ${roleName}`);
      console.log(`[Volt Core] Membership neon_superuser removida da role: ${app.user}`);
    }
  }

  return { user: app.user };
}

async function grantApplicationPrivileges(client, appRole) {
  if (!appRole?.user) return;
  const roleName = quoteIdentifier(appRole.user);
  const databaseResult = await client.query("select current_database() as name");
  const databaseName = quoteIdentifier(databaseResult.rows[0]?.name || "");
  await client.query(`GRANT CONNECT ON DATABASE ${databaseName} TO ${roleName}`);
  await client.query(`REVOKE CREATE ON SCHEMA volt_core FROM ${roleName}`);
  await client.query(`GRANT USAGE ON SCHEMA volt_core TO ${roleName}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA volt_core TO ${roleName}`);
  await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA volt_core TO ${roleName}`);
  await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA volt_core TO ${roleName}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA volt_core GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roleName}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA volt_core GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${roleName}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA volt_core GRANT EXECUTE ON FUNCTIONS TO ${roleName}`);

  const roleResult = await client.query(
    "select rolname, rolbypassrls, rolsuper from pg_roles where rolname = $1",
    [appRole.user],
  );
  const role = roleResult.rows[0];
  if (!role || role.rolbypassrls === true || role.rolsuper === true) {
    throw new Error(`A role ${appRole.user} nao ficou protegida por RLS.`);
  }
}

async function ensureMigrationsTable(client) {
  await client.query("create schema if not exists volt_core;");
  await client.query(`
    create table if not exists volt_core.migrations (
      id bigserial primary key,
      filename text not null unique,
      applied_at timestamptz not null default now()
    );
  `);
  await client.query("alter table volt_core.migrations add column if not exists checksum text;");
}

async function appliedMigration(client, filename) {
  const result = await client.query(
    "select filename, checksum from volt_core.migrations where filename = $1 limit 1",
    [filename],
  );
  return result.rows[0] || null;
}

async function markApplied(client, filename, checksum) {
  await client.query(
    `insert into volt_core.migrations (filename, checksum) values ($1, $2)
     on conflict (filename) do update set checksum = coalesce(volt_core.migrations.checksum, excluded.checksum)`,
    [filename, checksum],
  );
}

async function updateChecksum(client, filename, checksum) {
  await client.query(
    "update volt_core.migrations set checksum = $2 where filename = $1",
    [filename, checksum],
  );
}

function migrationChecksums(sql) {
  const normalizedSql = sql.replace(/\r\n/g, "\n");
  const crlfSql = normalizedSql.replace(/\n/g, "\r\n");
  const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

  return {
    current: hash(normalizedSql),
    eolVariants: new Set([hash(sql), hash(normalizedSql), hash(crlfSql)]),
  };
}

async function main() {
  if (!databaseUrl) {
    console.error("VOLT_CORE_DIRECT_DATABASE_URL ou VOLT_CORE_MIGRATION_DATABASE_URL nao configurada para migrations.");
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    ssl: wantsSsl(databaseUrl) ? { rejectUnauthorized: false } : false,
  });

  const files = fs
    .readdirSync(__dirname)
    .filter((file) => /^\d+_.*\.sql$/i.test(file))
    .sort((a, b) => a.localeCompare(b, "en"));

  await client.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('volt_core_migrations')); ");
    const appRole = await ensureApplicationRole(client);
    await ensureMigrationsTable(client);

    console.log(`[Volt Core] Encontradas ${files.length} migrations.`);
    for (const file of files) {
      const sql = fs.readFileSync(path.join(__dirname, file), "utf8");
      const { current: checksum, eolVariants } = migrationChecksums(sql);
      const applied = await appliedMigration(client, file);
      if (applied) {
        if (applied.checksum && !eolVariants.has(applied.checksum)) {
          throw new Error(`Migration ja aplicada foi alterada: ${file}`);
        }
        if (applied.checksum !== checksum) await updateChecksum(client, file, checksum);
        console.log(`[Volt Core] Pulando: ${file}`);
        continue;
      }

      console.log(`[Volt Core] Aplicando: ${file}`);
      await client.query("begin");
      try {
        await client.query(sql);
        await markApplied(client, file, checksum);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }

    await grantApplicationPrivileges(client, appRole);
    console.log("[Volt Core] Migrations finalizadas e role da aplicacao validada.");
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('volt_core_migrations')); ").catch(() => {});
    await client.end();
  }
}

main().catch((error) => {
  console.error("[Volt Core] Erro nas migrations:", error);
  process.exit(1);
});
