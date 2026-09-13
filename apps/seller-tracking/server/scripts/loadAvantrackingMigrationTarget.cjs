"use strict";

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { resolveAvantrackingDatabaseUrl } = require("../../databaseTarget.cjs");

const avantrackingOwnedEnvFiles = [
  path.join(__dirname, "..", ".env"),
  path.join(__dirname, "..", "..", ".env"),
];

function loadAvantrackingMigrationTarget(
  env = process.env,
  envFiles = avantrackingOwnedEnvFiles,
) {
  for (const envFile of envFiles) {
    if (!fs.existsSync(envFile)) {
      continue;
    }

    const parsed = dotenv.parse(fs.readFileSync(envFile, "utf8"));
    const localDatabaseUrl = String(
      parsed.AVANTRACKING_DATABASE_URL || parsed.DATABASE_URL || "",
    ).trim();

    if (localDatabaseUrl && !String(env.AVANTRACKING_DATABASE_URL || "").trim()) {
      env.AVANTRACKING_DATABASE_URL = localDatabaseUrl;
    }
  }

  return resolveAvantrackingDatabaseUrl(env);
}

module.exports = {
  avantrackingOwnedEnvFiles,
  loadAvantrackingMigrationTarget,
};
