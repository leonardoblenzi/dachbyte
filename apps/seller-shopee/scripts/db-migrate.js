"use strict";

const path = require("path");
const pg = require("pg");
const { runMigrationCli } = require("../../../lib/sqlMigrationRunner");

runMigrationCli({
  moduleName: "shopee",
  cliScriptName: "scripts/db-migrate.js",
  projectRoot: path.join(__dirname, ".."),
  migrationsDir: path.join(__dirname, "..", "db", "migrations"),
  legacyPrismaMigrationsDir: path.join(__dirname, "..", "db", "legacy-migrations"),
  envFiles: [
    path.join(__dirname, "..", "src", ".env"),
    path.join(__dirname, "..", ".env"),
  ],
  databaseEnvKeys: ["SHOPEE_DATABASE_URL", "DATABASE_URL"],
  allowChecksumReconcile: true,
  pg,
}).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
