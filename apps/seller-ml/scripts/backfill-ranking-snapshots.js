"use strict";

const path = require("path");
const { loadRuntimeEnv } = require("../../../lib/runtimeEnv");
const {
  assertTokenEncryptionConfigured,
} = require("../services/tokenCrypto");

loadRuntimeEnv({
  defaultCandidates: [
    path.join(__dirname, "..", ".env"),
    path.join(__dirname, "..", "..", ".env"),
  ],
});

assertTokenEncryptionConfigured("backfill de snapshots do ranking ML");

const { snapshots } = require("../routes/mercadolivreRankingRoutes");

function parseArgs(argv) {
  const args = {};
  for (const part of argv) {
    const match = String(part || "").match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const year = Number(args.year || new Date().getUTCFullYear());
  const months = String(args.months || "1,2,3,4")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 1 && value <= 12);
  const accountIds = String(args.accounts || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (!Number.isFinite(year) || year < 2020) {
    throw new Error("Informe um ano valido com --year=2026.");
  }
  if (!months.length) {
    throw new Error("Informe ao menos um mes valido com --months=1,2,3,4.");
  }

  console.log(`[Ranking] Backfill snapshots ano=${year} meses=${months.join(",")}`);
  const result = await snapshots.backfillMonthlySnapshots({
    year,
    months,
    accountIds: accountIds.length ? accountIds : null,
  });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[Ranking] Backfill falhou:", error?.message || error);
    process.exit(1);
  });
