import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const mode = process.argv[2] ?? 'migrate';
const isProduction = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';

const runtimeDatabaseUrl = process.env.VOLT_STOCK_DATABASE_URL || process.env.DATABASE_URL || '';
const migrationDatabaseUrl = process.env.VOLT_STOCK_MIGRATION_DATABASE_URL
  || process.env.VOLT_STOCK_DIRECT_DATABASE_URL
  || (!isProduction ? runtimeDatabaseUrl : '');

function assertDemoSeedAllowed() {
  if (isProduction && process.env.ALLOW_DEMO_SEED !== 'YES') {
    throw new Error('Seed demo bloqueado em producao. Para uma execucao excepcional e consciente, defina ALLOW_DEMO_SEED=YES.');
  }
}

if (!migrationDatabaseUrl) {
  console.error('VOLT_STOCK_MIGRATION_DATABASE_URL nao definido. Em producao, migrations devem usar uma role separada do runtime.');
  process.exit(1);
}

function clientOptions(databaseUrl) {
  return {
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('sslmode=require')
      ? { rejectUnauthorized: false }
      : undefined
  };
}

function parseIdentity(databaseUrl) {
  if (!databaseUrl) return null;
  const parsed = new URL(databaseUrl);
  return {
    user: decodeURIComponent(parsed.username || '').trim(),
    database: decodeURIComponent(String(parsed.pathname || '').replace(/^\//, ''))
  };
}

function quoteIdentifier(value) {
  return `"${String(value || '').replace(/"/g, '""')}"`;
}

const client = new Client(clientOptions(migrationDatabaseUrl));

async function listSqlFiles(relativeDir) {
  const dir = path.join(rootDir, relativeDir);
  const files = await fs.readdir(dir);
  return files
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => path.join(dir, file));
}

async function ensureMigrationsTable() {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function ensureRuntimePrivileges() {
  if (!runtimeDatabaseUrl) {
    if (isProduction) throw new Error('VOLT_STOCK_DATABASE_URL e obrigatoria em producao para validar a role runtime.');
    return;
  }

  const runtime = parseIdentity(runtimeDatabaseUrl);
  const migration = parseIdentity(migrationDatabaseUrl);
  if (!runtime?.user) throw new Error('VOLT_STOCK_DATABASE_URL deve informar o usuario explicitamente.');
  if (isProduction && migration?.user === runtime.user) {
    throw new Error('A role runtime do Stock deve ser diferente da role usada nas migrations para que RLS nao seja contornada pelo owner.');
  }

  const result = await client.query(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
    [runtime.user]
  );
  if (!result.rowCount) throw new Error(`Role runtime do Stock nao existe: ${runtime.user}. Execute o provisionamento PostgreSQL primeiro.`);
  if (result.rows[0].rolsuper === true || result.rows[0].rolbypassrls === true) {
    throw new Error(`Role runtime do Stock insegura: ${runtime.user} possui SUPERUSER ou BYPASSRLS.`);
  }

  const role = quoteIdentifier(runtime.user);
  const database = quoteIdentifier(runtime.database);
  await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
  await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  await client.query(`REVOKE CREATE ON SCHEMA public FROM ${role}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${role}`);

  const appSchema = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = 'app'");
  if (appSchema.rowCount) {
    await client.query(`GRANT USAGE ON SCHEMA app TO ${role}`);
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT EXECUTE ON FUNCTIONS TO ${role}`);
  }
}

async function migrate() {
  await ensureMigrationsTable();
  const files = await listSqlFiles('database/migrations');

  for (const file of files) {
    const version = path.basename(file);
    const alreadyApplied = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
    if (alreadyApplied.rowCount) {
      console.log(`skip ${version}`);
      continue;
    }

    const sql = await fs.readFile(file, 'utf8');
    console.log(`apply ${version}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  await ensureRuntimePrivileges();
}

async function seed() {
  assertDemoSeedAllowed();
  const files = await listSqlFiles('database/seeds');
  for (const file of files) {
    const version = path.basename(file);
    const sql = await fs.readFile(file, 'utf8');
    console.log(`seed ${version}`);
    await client.query(sql);
  }
}

async function reset() {
  if (process.env.ALLOW_DB_RESET !== 'YES') {
    throw new Error('Reset bloqueado. Defina ALLOW_DB_RESET=YES para dropar e recriar o schema public.');
  }
  if (isProduction) {
    throw new Error('Reset de banco bloqueado em NODE_ENV=production, mesmo com ALLOW_DB_RESET=YES.');
  }

  await client.query('DROP SCHEMA public CASCADE');
  await client.query('CREATE SCHEMA public');
  await client.query('GRANT ALL ON SCHEMA public TO public');
}

try {
  await client.connect();
  await client.query("SELECT pg_advisory_lock(hashtext('volt_stock_migrations'))");

  if (mode === 'migrate') {
    await migrate();
  } else if (mode === 'seed') {
    await migrate();
    await seed();
  } else if (mode === 'reset') {
    await reset();
    await migrate();
    await seed();
  } else {
    throw new Error(`Modo desconhecido: ${mode}`);
  }

  console.log('ok');
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('volt_stock_migrations'))").catch(() => {});
  await client.end();
}
