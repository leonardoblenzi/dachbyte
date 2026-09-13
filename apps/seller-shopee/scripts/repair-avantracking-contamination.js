"use strict";

const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");
const { Pool } = require("pg");
const {
  assertDistinctDatabaseTargets,
  canonicalizeDatabaseTarget,
  resolveAvantrackingDatabaseUrl,
} = require("../../avantracking/databaseTarget.cjs");
const {
  MISPLACED_MIGRATIONS,
  buildRepairPlan,
  executeRepair,
  inspectContamination,
  validatePreflight,
} = require("./lib/avantrackingContamination");

const SHOPEE_ENV_FILE = path.join(__dirname, "..", "src", ".env");
const AVANTRACKING_ENV_FILES = Object.freeze([
  path.join(__dirname, "..", "..", "avantracking", "server", ".env"),
  path.join(__dirname, "..", "..", "avantracking", ".env"),
]);

function loadShopeeDatabaseUrl(env = process.env) {
  if (fs.existsSync(SHOPEE_ENV_FILE)) {
    const parsed = dotenv.parse(fs.readFileSync(SHOPEE_ENV_FILE, "utf8"));
    if (!String(env.DATABASE_URL || "").trim() && parsed.DATABASE_URL) {
      env.DATABASE_URL = parsed.DATABASE_URL;
    }
  }

  const databaseUrl = String(env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL do Shopee nao configurada.");
  return databaseUrl;
}

function loadAvantrackingDatabaseUrl(env = process.env, envFiles = AVANTRACKING_ENV_FILES) {
  for (const envFile of envFiles) {
    if (!fs.existsSync(envFile)) continue;
    const parsed = dotenv.parse(fs.readFileSync(envFile, "utf8"));
    if (!String(env.AVANTRACKING_DATABASE_URL || "").trim() && parsed.AVANTRACKING_DATABASE_URL) {
      env.AVANTRACKING_DATABASE_URL = parsed.AVANTRACKING_DATABASE_URL;
    }
  }
  return resolveAvantrackingDatabaseUrl(env);
}

function parseArguments(argv) {
  const expectedTarget = argv.find((argument) => argument.startsWith("--expected-target="));
  return {
    apply: argv.includes("--apply"),
    expectedFingerprint: expectedTarget ? expectedTarget.slice("--expected-target=".length) : "",
  };
}

function resolveSslOptions(connectionString) {
  try {
    const parsed = new URL(connectionString);
    const sslMode = String(parsed.searchParams.get("sslmode") || "").toLowerCase();
    const sslFlag = String(parsed.searchParams.get("ssl") || "").toLowerCase();
    if (sslMode === "verify-ca" || sslMode === "verify-full") {
      return { rejectUnauthorized: true };
    }
    if (
      sslMode === "require"
      || sslMode === "prefer"
      || sslFlag === "true"
      || /\.neon\.(tech|build)$/i.test(parsed.hostname)
    ) {
      return { rejectUnauthorized: false };
    }
  } catch (_error) {
    return undefined;
  }
  return undefined;
}

function buildPool(connectionString) {
  return new Pool({
    connectionString,
    ssl: resolveSslOptions(connectionString),
    max: 1,
  });
}

function buildDryRunSummary(report) {
  let activeAvantrackingRows = 0;
  for (const count of report.tableRowCounts?.values() || []) {
    activeAvantrackingRows += Number(count || 0);
  }

  return {
    writeMode: false,
    shopeeTarget: { fingerprint: report.shopeeTarget.fingerprint },
    avantrackingTarget: { fingerprint: report.avantrackingTarget.fingerprint },
    counts: {
      misplacedMigrations: countMisplacedMigrations(report.shopeeAppliedMigrations),
      avantrackingReferenceMigrations: countMisplacedMigrations(report.avantrackingAppliedMigrations),
      activeAvantrackingObjects: report.activeAvantrackingObjects.length,
      activeAvantrackingRows,
      foreignKeys: report.foreignKeys.length,
      criticalColumns: report.criticalColumnTypes.length,
      nonNumericUserIds: report.nonNumericUserIdCount,
    },
  };
}

function buildApplySummary(report, repairResult) {
  return {
    writeMode: true,
    committed: repairResult.committed,
    noOp: repairResult.noOp,
    shopeeTarget: { fingerprint: report.shopeeTarget.fingerprint },
    avantrackingTarget: { fingerprint: report.avantrackingTarget.fingerprint },
    counts: {
      operations: repairResult.operationCount,
      movedTables: repairResult.movedTableCount,
      quarantinedMigrations: repairResult.quarantinedMigrationCount,
    },
  };
}

function buildRepairedNoOpSummary(report, apply) {
  return {
    writeMode: Boolean(apply),
    committed: true,
    noOp: true,
    shopeeTarget: { fingerprint: report.shopeeTarget.fingerprint },
    avantrackingTarget: { fingerprint: report.avantrackingTarget.fingerprint },
    counts: {
      operations: 0,
      movedTables: 0,
      quarantinedMigrations: MISPLACED_MIGRATIONS.length,
    },
  };
}

function countMisplacedMigrations(appliedMigrations) {
  return MISPLACED_MIGRATIONS.filter((migration) => appliedMigrations.has(migration)).length;
}

function safeErrorMessage(error) {
  return String(error?.message || error || "Falha desconhecida.")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database-url-redacted]");
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const { apply, expectedFingerprint } = parseArguments(argv);
  const shopeeDatabaseUrl = loadShopeeDatabaseUrl(env);
  const avantrackingDatabaseUrl = loadAvantrackingDatabaseUrl(env);
  const summary = await runPreflight({
    shopeeDatabaseUrl,
    avantrackingDatabaseUrl,
    expectedFingerprint,
    apply,
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

async function runPreflight({
  shopeeDatabaseUrl,
  avantrackingDatabaseUrl,
  expectedFingerprint,
  apply = false,
}, {
  createPool = buildPool,
  inspect = inspectContamination,
  buildPlan = buildRepairPlan,
  execute = executeRepair,
} = {}) {
  assertDistinctDatabaseTargets(shopeeDatabaseUrl, avantrackingDatabaseUrl);
  let shopeePool;
  let avantrackingPool;
  let shopeeClient;
  let avantrackingClient;

  try {
    shopeePool = createPool(shopeeDatabaseUrl);
    avantrackingPool = createPool(avantrackingDatabaseUrl);
    shopeeClient = await shopeePool.connect();
    avantrackingClient = await avantrackingPool.connect();
    shopeeClient.databaseTarget = canonicalizeDatabaseTarget(shopeeDatabaseUrl);
    avantrackingClient.databaseTarget = canonicalizeDatabaseTarget(avantrackingDatabaseUrl);
    const report = await inspect(shopeeClient, avantrackingClient);
    validatePreflight(report, expectedFingerprint);
    if (report.repairState?.status === "repaired") {
      return buildRepairedNoOpSummary(report, apply);
    }
    if (!apply) return buildDryRunSummary(report);

    const plan = buildPlan(report);
    const repairResult = await execute(shopeeClient, plan);
    return buildApplySummary(report, repairResult);
  } finally {
    await Promise.allSettled([
      ...(avantrackingClient ? [Promise.resolve().then(() => avantrackingClient.release())] : []),
      ...(shopeeClient ? [Promise.resolve().then(() => shopeeClient.release())] : []),
      ...(avantrackingPool ? [Promise.resolve().then(() => avantrackingPool.end())] : []),
      ...(shopeePool ? [Promise.resolve().then(() => shopeePool.end())] : []),
    ]);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Preflight Avantracking: ${safeErrorMessage(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  MISPLACED_MIGRATIONS,
  buildApplySummary,
  buildDryRunSummary,
  buildRepairedNoOpSummary,
  loadAvantrackingDatabaseUrl,
  loadShopeeDatabaseUrl,
  main,
  parseArguments,
  resolveSslOptions,
  runPreflight,
  safeErrorMessage,
};
