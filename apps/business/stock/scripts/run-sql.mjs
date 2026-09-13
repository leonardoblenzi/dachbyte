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
const databaseUrl = process.env.VOLT_STOCK_DATABASE_URL || process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('VOLT_STOCK_DATABASE_URL ou DATABASE_URL nao definido. Configure o PostgreSQL/Neon.');
  process.exit(1);
}

const client = new Client({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined
});

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
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
  }
}

async function seed() {
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

  await client.query('DROP SCHEMA public CASCADE');
  await client.query('CREATE SCHEMA public');
  await client.query('GRANT ALL ON SCHEMA public TO public');
}

try {
  await client.connect();

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
  await client.end();
}
