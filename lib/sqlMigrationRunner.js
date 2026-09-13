"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const HISTORY_TABLE = "_davantti_sql_migrations";

function loadEnvFiles(envFiles) {
  for (const envFile of envFiles || []) {
    if (!envFile || !fs.existsSync(envFile)) {
      continue;
    }

    const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
        continue;
      }

      let value = line.slice(separatorIndex + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  }
}

function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, "\"\"")}"`;
}

function slugifyMigrationName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function buildTimestamp() {
  const now = new Date();
  const parts = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    String(now.getUTCHours()).padStart(2, "0"),
    String(now.getUTCMinutes()).padStart(2, "0"),
    String(now.getUTCSeconds()).padStart(2, "0"),
  ];

  return parts.join("");
}

function computeChecksum(content) {
  return crypto.createHash("sha256").update(String(content).replace(/\r\n/g, "\n")).digest("hex");
}

function resolveSslOption(connectionString) {
  try {
    const parsed = new URL(connectionString);
    const sslMode = String(parsed.searchParams.get("sslmode") || "").toLowerCase();
    const sslFlag = String(parsed.searchParams.get("ssl") || "").toLowerCase();

    if (
      sslMode === "require" ||
      sslMode === "prefer" ||
      sslMode === "verify-ca" ||
      sslMode === "verify-full" ||
      sslFlag === "true" ||
      /\.neon\.(tech|build)$/i.test(parsed.hostname)
    ) {
      return { rejectUnauthorized: false };
    }
  } catch (_error) {
    return undefined;
  }

  return undefined;
}

function resolveDatabaseUrl(databaseEnvKeys) {
  for (const envKey of databaseEnvKeys || []) {
    const value = String(process.env[envKey] || "").trim();
    if (value) {
      return {
        envKey,
        value,
      };
    }
  }

  return null;
}

function readMigrationEntries(migrationsDir) {
  if (!migrationsDir || !fs.existsSync(migrationsDir)) {
    return [];
  }

  const entries = [];
  const dirEntries = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of dirEntries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    if (entry.isDirectory()) {
      const sqlFile = path.join(migrationsDir, entry.name, "migration.sql");
      if (!fs.existsSync(sqlFile)) {
        continue;
      }

      const sql = fs.readFileSync(sqlFile, "utf8");
      entries.push({
        name: entry.name,
        filePath: sqlFile,
        sql,
        checksum: computeChecksum(sql),
      });
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".sql")) {
      const sqlFile = path.join(migrationsDir, entry.name);
      const sql = fs.readFileSync(sqlFile, "utf8");
      entries.push({
        name: entry.name.replace(/\.sql$/i, ""),
        filePath: sqlFile,
        sql,
        checksum: computeChecksum(sql),
      });
    }
  }

  return entries;
}

async function ensureHistoryTable(client, historyTable) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${quoteIdent(historyTable)} (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'script',
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      execution_ms INTEGER
    )
  `);
}

async function loadAppliedMigrations(client, historyTable) {
  const result = await client.query(
    `SELECT name, checksum, source, applied_at FROM ${quoteIdent(historyTable)} ORDER BY applied_at ASC, name ASC`,
  );

  return new Map(result.rows.map((row) => [row.name, row]));
}

async function prismaHistoryExists(client) {
  const result = await client.query("SELECT to_regclass('public._prisma_migrations') AS table_name");
  return Boolean(result.rows[0] && result.rows[0].table_name);
}

async function baselinePrismaMigrations(client, config) {
  if (!config.legacyPrismaMigrationsDir || !(await prismaHistoryExists(client))) {
    return {
      imported: 0,
      available: 0,
    };
  }

  const historyTable = config.historyTable || HISTORY_TABLE;
  const applied = await loadAppliedMigrations(client, historyTable);
  const legacyFiles = readMigrationEntries(config.legacyPrismaMigrationsDir);
  const checksumByName = new Map(legacyFiles.map((entry) => [entry.name, entry.checksum]));

  const prismaRows = await client.query(`
    SELECT migration_name
    FROM "_prisma_migrations"
    WHERE finished_at IS NOT NULL
    ORDER BY migration_name ASC
  `);

  let imported = 0;

  for (const row of prismaRows.rows) {
    const name = row.migration_name;
    if (applied.has(name)) {
      continue;
    }

    await client.query(
      `
        INSERT INTO ${quoteIdent(historyTable)} (name, checksum, source)
        VALUES ($1, $2, 'prisma-baseline')
      `,
      [name, checksumByName.get(name) || "legacy-prisma"],
    );
    imported += 1;
  }

  return {
    imported,
    available: prismaRows.rowCount,
  };
}

async function countBusinessTables(client, historyTable) {
  const result = await client.query(
    `
      SELECT COUNT(*)::int AS total
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name NOT IN ($1, '_prisma_migrations')
    `,
    [historyTable],
  );

  return Number(result.rows?.[0]?.total || 0);
}

async function applyLegacyMigrationsIfFreshDatabase(client, config, historyTable) {
  if (!config.legacyPrismaMigrationsDir) {
    return { applied: 0, skipped: "no_legacy_dir" };
  }

  const legacyMigrations = readMigrationEntries(config.legacyPrismaMigrationsDir);
  if (!legacyMigrations.length) {
    return { applied: 0, skipped: "no_legacy_migrations" };
  }

  const applied = await loadAppliedMigrations(client, historyTable);
  if (applied.size > 0) {
    return { applied: 0, skipped: "history_not_empty" };
  }

  if (await prismaHistoryExists(client)) {
    return { applied: 0, skipped: "prisma_history_exists" };
  }

  const businessTables = await countBusinessTables(client, historyTable);
  if (businessTables > 0) {
    return { applied: 0, skipped: "non_empty_database" };
  }

  let appliedCount = 0;
  for (const migration of legacyMigrations) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(migration.sql);
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `
        INSERT INTO ${quoteIdent(historyTable)} (name, checksum, source)
        VALUES ($1, $2, 'legacy-script')
      `,
      [migration.name, migration.checksum],
    );
    appliedCount += 1;
  }

  return { applied: appliedCount, skipped: null };
}

async function withClient(config, callback) {
  loadEnvFiles(config.envFiles);

  const databaseConfig = resolveDatabaseUrl(config.databaseEnvKeys);

  if (!databaseConfig) {
    throw new Error(
      `Nenhuma URL de banco encontrada. Configure uma das variaveis: ${(config.databaseEnvKeys || []).join(", ")}`,
    );
  }

  const client = new config.pg.Client({
    connectionString: databaseConfig.value,
    ssl: resolveSslOption(databaseConfig.value),
  });

  await client.connect();

  try {
    return await callback(client, databaseConfig);
  } finally {
    await client.end();
  }
}

function printUsage(config) {
  console.log(`Uso: node ${config.cliScriptName} <comando> [args]`);
  console.log("");
  console.log("Comandos:");
  console.log("  create <nome>         Cria uma nova migration SQL");
  console.log("  deploy                Aplica migrations pendentes");
  console.log("  status                Mostra migrations aplicadas e pendentes");
  console.log("  execute <arquivo.sql> Executa um arquivo SQL sem registrar migration");
  console.log("  baseline              Importa historico legado do _prisma_migrations");
}

function createMigration(config, rawName) {
  const slug = slugifyMigrationName(rawName);

  if (!slug) {
    throw new Error("Informe um nome valido para a migration.");
  }

  const migrationsDir = config.migrationsDir;
  const folderName = `${buildTimestamp()}_${slug}`;
  const migrationDir = path.join(migrationsDir, folderName);
  const migrationFile = path.join(migrationDir, "migration.sql");

  if (fs.existsSync(migrationDir)) {
    throw new Error(`A migration ${folderName} ja existe.`);
  }

  fs.mkdirSync(migrationDir, { recursive: true });
  fs.writeFileSync(
    migrationFile,
    [
      `-- Migration: ${folderName}`,
      `-- Module: ${config.moduleName}`,
      `-- Executada manualmente no banco definido em ${config.databaseEnvKeys[0]}`,
      "",
      "BEGIN;",
      "",
      "-- Escreva aqui o SQL da migration.",
      "",
      "COMMIT;",
      "",
    ].join("\n"),
    "utf8",
  );

  console.log(`Migration criada em: ${migrationFile}`);
}

async function deployMigrations(config) {
  await withClient(config, async (client, databaseConfig) => {
    const historyTable = config.historyTable || HISTORY_TABLE;
    await ensureHistoryTable(client, historyTable);
    await baselinePrismaMigrations(client, config);
    const legacyBootstrap = await applyLegacyMigrationsIfFreshDatabase(
      client,
      config,
      historyTable,
    );
    if (legacyBootstrap.applied > 0) {
      console.log(
        `Banco vazio detectado. ${legacyBootstrap.applied} migration(s) legada(s) aplicada(s) em bootstrap.`,
      );
    }

    const applied = await loadAppliedMigrations(client, historyTable);
    const migrations = readMigrationEntries(config.migrationsDir);
    let appliedNow = 0;

    for (const migration of migrations) {
      const existing = applied.get(migration.name);

      if (existing) {
        if (existing.checksum !== migration.checksum) {
          if (config.allowChecksumReconcile === true) {
            await client.query(
              `
                UPDATE ${quoteIdent(historyTable)}
                SET checksum = $2,
                    source = CASE
                      WHEN source = 'script' THEN 'script-reconciled'
                      ELSE source
                    END
                WHERE name = $1
              `,
              [migration.name, migration.checksum],
            );
            console.warn(
              `Checksum divergente reconciliado para ${migration.name}.`,
            );
            continue;
          }

          throw new Error(
            `Checksum divergente para ${migration.name}. Nao altere migrations ja aplicadas.`,
          );
        }

        continue;
      }

      const startedAt = Date.now();
      console.log(`Aplicando ${migration.name}...`);
      await client.query(migration.sql);
      await client.query(
        `
          INSERT INTO ${quoteIdent(historyTable)} (name, checksum, source, execution_ms)
          VALUES ($1, $2, 'script', $3)
        `,
        [migration.name, migration.checksum, Date.now() - startedAt],
      );
      appliedNow += 1;
      console.log(`Aplicada ${migration.name}.`);
    }

    if (appliedNow === 0) {
      console.log(`Nenhuma migration pendente em ${config.migrationsDir}.`);
    } else {
      console.log(
        `${appliedNow} migration(s) aplicada(s) com sucesso usando ${databaseConfig.envKey}.`,
      );
    }
  });
}

async function showStatus(config) {
  await withClient(config, async (client, databaseConfig) => {
    const historyTable = config.historyTable || HISTORY_TABLE;
    await ensureHistoryTable(client, historyTable);
    const baseline = await baselinePrismaMigrations(client, config);
    const applied = await loadAppliedMigrations(client, historyTable);
    const migrations = readMigrationEntries(config.migrationsDir);
    const pending = migrations.filter((migration) => !applied.has(migration.name));

    console.log(`Banco conectado via ${databaseConfig.envKey}.`);
    console.log(`Historico local: ${applied.size} migration(s).`);
    console.log(`Pendentes: ${pending.length}.`);

    if (baseline.imported > 0) {
      console.log(
        `Historico Prisma importado: ${baseline.imported} de ${baseline.available} migration(s).`,
      );
    }

    if (pending.length > 0) {
      console.log("");
      console.log("Migrations pendentes:");
      for (const migration of pending) {
        console.log(`- ${migration.name}`);
      }
    }
  });
}

async function executeSqlFile(config, rawFilePath) {
  if (!rawFilePath) {
    throw new Error("Informe o caminho do arquivo SQL.");
  }

  const filePath = path.resolve(config.projectRoot, rawFilePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Arquivo SQL nao encontrado: ${filePath}`);
  }

  const sql = fs.readFileSync(filePath, "utf8");

  await withClient(config, async (client, databaseConfig) => {
    await client.query(sql);
    console.log(`Arquivo executado com sucesso via ${databaseConfig.envKey}: ${filePath}`);
  });
}

async function runBaseline(config) {
  await withClient(config, async (client, databaseConfig) => {
    const historyTable = config.historyTable || HISTORY_TABLE;
    await ensureHistoryTable(client, historyTable);
    const result = await baselinePrismaMigrations(client, config);

    console.log(`Banco conectado via ${databaseConfig.envKey}.`);
    console.log(
      `Historico Prisma importado: ${result.imported} de ${result.available} migration(s).`,
    );
  });
}

async function runMigrationCli(config) {
  const command = process.argv[2];
  const argument = process.argv[3];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage(config);
    return;
  }

  if (command === "create") {
    createMigration(config, argument);
    return;
  }

  if (command === "deploy") {
    await deployMigrations(config);
    return;
  }

  if (command === "status") {
    await showStatus(config);
    return;
  }

  if (command === "execute") {
    await executeSqlFile(config, argument);
    return;
  }

  if (command === "baseline" || command === "baseline-prisma") {
    await runBaseline(config);
    return;
  }

  throw new Error(`Comando invalido: ${command}`);
}

module.exports = {
  runMigrationCli,
};
