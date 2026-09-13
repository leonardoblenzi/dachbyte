"use strict";

const path = require("path");
const pg = require("pg");
const { runMigrationCli } = require("../../../../lib/sqlMigrationRunner");
const {
  avantrackingOwnedEnvFiles,
  loadAvantrackingMigrationTarget,
} = require("./loadAvantrackingMigrationTarget.cjs");

loadAvantrackingMigrationTarget(process.env);

runMigrationCli({
  moduleName: "avantracking",
  cliScriptName: "scripts/db-migrate.js",
  projectRoot: path.join(__dirname, ".."),
  migrationsDir: path.join(__dirname, "..", "db", "migrations"),
  legacyPrismaMigrationsDir: path.join(__dirname, "..", "db", "legacy-migrations"),
  envFiles: avantrackingOwnedEnvFiles,
  databaseEnvKeys: ["AVANTRACKING_DATABASE_URL"],
  allowChecksumReconcile: true,
  pg,
}).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
