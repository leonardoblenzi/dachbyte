"use strict";

const path = require("path");
const pg = require("pg");
const { runMigrationCli } = require("../../../lib/sqlMigrationRunner");

runMigrationCli({
  moduleName: "MadeiraMadeira",
  cliScriptName: "scripts/db-migrate.js",
  projectRoot: path.join(__dirname, ".."),
  migrationsDir: path.join(__dirname, "..", "db", "migrations"),
  legacyPrismaMigrationsDir: path.join(__dirname, "..", "prisma", "migrations"),
  envFiles: [path.join(__dirname, "..", ".env")],
  databaseEnvKeys: ["MAD_DIRECT_DATABASE_URL", "MAD_DATABASE_URL"],
  pg,
}).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
