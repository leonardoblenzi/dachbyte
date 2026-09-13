"use strict";

const HUB_ENABLED_MODES = new Set(["fallback", "mirror", "strict"]);
const HUB_DISABLED_MODES = new Set(["disabled", "off", "none", "false", "0"]);
const PLACEHOLDER_VALUES = new Set(["change-me", "changeme", "example", "secret", "password"]);

function isPlaceholder(value) {
  return PLACEHOLDER_VALUES.has(String(value || "").trim().toLowerCase());
}

function databaseUser(databaseUrl) {
  try {
    return decodeURIComponent(new URL(databaseUrl).username || "").trim();
  } catch (_error) {
    return "";
  }
}

function validateProductionEnvironment(environment = process.env) {
  const errors = [];
  const warnings = [];
  const get = (name) => String(environment[name] || "").trim();
  const production = get("NODE_ENV").toLowerCase() === "production";
  const legacyDatabaseUrl = get("VOLT_CORE_DATABASE_URL") || get("DATABASE_URL");
  const appDatabaseUrl = get("VOLT_CORE_APP_DATABASE_URL") || (!production ? legacyDatabaseUrl : "");
  const migrationDatabaseUrl = get("VOLT_CORE_MIGRATION_DATABASE_URL")
    || get("VOLT_CORE_DIRECT_DATABASE_URL")
    || (!production ? legacyDatabaseUrl : "");
  const jwtSecret = get("VOLT_CORE_JWT_SECRET") || get("JWT_SECRET");
  const hubMode = (get("HUB_LOGIN_MODE") || "fallback").toLowerCase();
  const bootstrapEnabled = ["1", "true"].includes(get("VOLT_CORE_BOOTSTRAP_MASTER_ENABLED").toLowerCase());

  if (production) {
    if (!appDatabaseUrl) errors.push("Defina VOLT_CORE_APP_DATABASE_URL com uma role exclusiva da aplicacao e NOBYPASSRLS.");
    if (!migrationDatabaseUrl) errors.push("Defina VOLT_CORE_DIRECT_DATABASE_URL (ou VOLT_CORE_MIGRATION_DATABASE_URL) somente para migrations.");
    if (appDatabaseUrl && migrationDatabaseUrl) {
      const appUser = databaseUser(appDatabaseUrl);
      const migrationUser = databaseUser(migrationDatabaseUrl);
      if (!appUser || !migrationUser) errors.push("As URLs PostgreSQL precisam informar usuario explicitamente.");
      if (appUser && migrationUser && appUser === migrationUser) {
        errors.push("A role da aplicacao deve ser diferente da role owner/migration. Use VOLT_CORE_APP_DATABASE_URL com usuario NOBYPASSRLS.");
      }
    }
  } else if (!appDatabaseUrl) {
    errors.push("Defina VOLT_CORE_APP_DATABASE_URL ou VOLT_CORE_DATABASE_URL/DATABASE_URL.");
  }

  if (!jwtSecret) errors.push("Defina VOLT_CORE_JWT_SECRET (ou JWT_SECRET).");
  if (jwtSecret && isPlaceholder(jwtSecret)) errors.push("Substitua o placeholder de VOLT_CORE_JWT_SECRET por um segredo real.");
  if (jwtSecret && !isPlaceholder(jwtSecret) && jwtSecret.length < 32) warnings.push("Use um segredo JWT com pelo menos 32 caracteres aleatorios.");

  if (!HUB_ENABLED_MODES.has(hubMode) && !HUB_DISABLED_MODES.has(hubMode)) {
    errors.push(`HUB_LOGIN_MODE invalido: ${hubMode}. Use fallback, mirror, strict ou disabled.`);
  }
  if (HUB_ENABLED_MODES.has(hubMode)) {
    if (!get("HUB_BASE_URL")) errors.push(`HUB_LOGIN_MODE=${hubMode} exige HUB_BASE_URL.`);
    if (!get("HUB_INTERNAL_TOKEN")) errors.push(`HUB_LOGIN_MODE=${hubMode} exige HUB_INTERNAL_TOKEN.`);
    if (isPlaceholder(get("HUB_INTERNAL_TOKEN"))) errors.push("Substitua o placeholder de HUB_INTERNAL_TOKEN por um token real.");
  }

  if (bootstrapEnabled) {
    if (!get("VOLT_CORE_BOOTSTRAP_MASTER_EMAIL")) errors.push("Bootstrap master exige VOLT_CORE_BOOTSTRAP_MASTER_EMAIL.");
    if (!get("VOLT_CORE_BOOTSTRAP_MASTER_PASSWORD") && !get("VOLT_CORE_BOOTSTRAP_MASTER_PASSWORD_HASH")) {
      errors.push("Bootstrap master exige senha ou hash de senha.");
    }
    if (isPlaceholder(get("VOLT_CORE_BOOTSTRAP_MASTER_PASSWORD"))) {
      errors.push("Substitua o placeholder da senha do bootstrap master.");
    }
    warnings.push("Desative VOLT_CORE_BOOTSTRAP_MASTER_ENABLED depois de provisionar o master definitivo.");
  }

  if (!get("VOLT_CORE_ALLOWED_ORIGINS")) {
    warnings.push("VOLT_CORE_ALLOWED_ORIGINS vazio: apenas chamadas same-origin funcionarao no navegador.");
  }
  if (production && ["1", "true"].includes(get("VOLT_CORE_WORKER_DISABLED").toLowerCase())) {
    warnings.push("VOLT_CORE_WORKER_DISABLED=true: confirme que existe um worker de integracoes separado rodando `npm run worker:integrations`.");
  }

  return { ok: errors.length === 0, errors, warnings };
}

function run() {
  const result = validateProductionEnvironment(process.env);
  for (const warning of result.warnings) console.warn(`[preflight] AVISO: ${warning}`);
  if (!result.ok) {
    for (const error of result.errors) console.error(`[preflight] ERRO: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log("[preflight] Configuracao minima de producao valida.");
}

if (require.main === module) run();

module.exports = { databaseUser, validateProductionEnvironment };
