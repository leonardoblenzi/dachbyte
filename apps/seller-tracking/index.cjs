"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const { resolveAvantrackingDatabaseUrl } = require("./databaseTarget.cjs");

function tryRequireDotenv() {
  try {
    return require("dotenv");
  } catch (_error) {
    return null;
  }
}

function loadModuleEnvMap(envFilePaths) {
  const dotenv = tryRequireDotenv();
  if (!dotenv || typeof dotenv.parse !== "function") {
    return {};
  }

  const merged = {};

  for (const envFilePath of envFilePaths) {
    if (!fs.existsSync(envFilePath)) {
      continue;
    }

    try {
      const parsed = dotenv.parse(fs.readFileSync(envFilePath));
      for (const [key, value] of Object.entries(parsed || {})) {
        if (!(key in merged)) {
          merged[key] = String(value || "").trim();
        }
      }
    } catch (_error) {}
  }

  return merged;
}

function setEnvIfMissing(key, value) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue || process.env[key]) {
    return;
  }

  process.env[key] = normalizedValue;
}

const moduleEnvCandidates = [
  path.join(__dirname, "server", ".env"),
  path.join(__dirname, ".env"),
];

const moduleEnv = loadModuleEnvMap(moduleEnvCandidates);
const passthroughKeys = [
  "AVANTRACKING_JWT_SECRET",
  "AVANTRACKING_BASE_PATH",
  "JWT_SECRET",
  "TRAY_CONSUMER_KEY",
  "TRAY_CONSUMER_SECRET",
  "TRAY_CALLBACK_URL",
  "BREVO_API_KEY",
  "BREVO_SENDER_EMAIL",
  "BREVO_SENDER_NAME",
  "APP_BASE_URL",
  "FRONTEND_URL",
  "REPORTS_BASE_URL",
  "BACKEND_URL",
  "RENDER_EXTERNAL_URL",
  "HUB_BASE_URL",
  "HUB_INTERNAL_TOKEN",
  "HUB_REQUEST_TIMEOUT_MS",
  "HUB_RESOURCE_BILLING_MODE",
];

for (const key of passthroughKeys) {
  setEnvIfMissing(key, moduleEnv[key]);
}

if (!process.env.JWT_SECRET && process.env.AVANTRACKING_JWT_SECRET) {
  process.env.JWT_SECRET = process.env.AVANTRACKING_JWT_SECRET;
}

const moduleDatabaseUrl =
  String(moduleEnv.AVANTRACKING_DATABASE_URL || "").trim() ||
  String(moduleEnv.DATABASE_URL || "").trim();

setEnvIfMissing("AVANTRACKING_DATABASE_URL", moduleDatabaseUrl);
resolveAvantrackingDatabaseUrl(process.env);

if (!process.env.APP_BASE_PATH && process.env.AVANTRACKING_BASE_PATH) {
  process.env.APP_BASE_PATH = process.env.AVANTRACKING_BASE_PATH;
}

if (!process.env.APP_BASE_PATH) {
  process.env.APP_BASE_PATH = "/avantracking";
}

if (!process.env.AVANTRACKING_BASE_PATH) {
  process.env.AVANTRACKING_BASE_PATH = process.env.APP_BASE_PATH;
}

if (!process.env.APP_BASE_URL && process.env.RENDER_EXTERNAL_URL) {
  const externalBaseUrl = String(process.env.RENDER_EXTERNAL_URL).replace(/\/+$/, "");
  process.env.APP_BASE_URL = `${externalBaseUrl}${process.env.APP_BASE_PATH}`;
}

let schedulesInitialized = false;
let migrationsInitialized = false;

function shouldSkipMigrationOnBoot() {
  const raw = String(process.env.AVANTRACKING_SKIP_DB_MIGRATE_ON_BOOT || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function ensureDatabaseMigrations() {
  if (migrationsInitialized || shouldSkipMigrationOnBoot()) {
    return;
  }

  const serverRoot = path.join(__dirname, "server");
  const migrationCli = path.join(serverRoot, "scripts", "db-migrate.js");

  if (!fs.existsSync(migrationCli)) {
    throw new Error(
      `[AVANTRACKING] Nao foi possivel localizar o runner de migrations: ${migrationCli}`,
    );
  }

  console.log("[AVANTRACKING] Executando db:migrate:deploy no bootstrap...");

  childProcess.execFileSync(process.execPath, [migrationCli, "deploy"], {
    cwd: serverRoot,
    env: process.env,
    stdio: "inherit",
  });

  migrationsInitialized = true;
  console.log("[AVANTRACKING] db:migrate:deploy concluido.");
}

async function createAvantrackingApp() {
  ensureDatabaseMigrations();

  const modulePath = path.join(__dirname, "server", "dist", "index.js");
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const avantrackingModule = require(modulePath);
  const createApp =
    avantrackingModule.createAvantrackingApp || avantrackingModule.default;

  if (typeof createApp !== "function") {
    throw new Error("Nao foi possivel inicializar o modulo Avantracking.");
  }

  if (
    !schedulesInitialized &&
    typeof avantrackingModule.initializeAvantrackingSchedules === "function"
  ) {
    await avantrackingModule.initializeAvantrackingSchedules();
    schedulesInitialized = true;
  }

  return createApp();
}

module.exports = createAvantrackingApp;
