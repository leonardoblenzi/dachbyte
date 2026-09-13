"use strict";

function trimToNull(value) {
  const normalized = String(value || "").trim();
  return normalized ? normalized : null;
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeEnvironment(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (["sandbox", "prod", "producao"].includes(normalized)) {
    return "production";
  }

  return "sandbox";
}

const runtimeEnvironment = normalizeEnvironment(
  process.env.MADEIRA_ENV || process.env.MADEIRA_API_ENV || "production",
);

const defaultCoreBaseUrl = "https://marketplace.madeiramadeira.com.br";

const env = {
  moduleName: "MadeiraMadeira",
  runtimeEnvironment,
  coreBaseUrl: trimToNull(process.env.MADEIRA_API_BASE_URL) || defaultCoreBaseUrl,
  apiToken: trimToNull(process.env.MADEIRA_API_TOKEN),
  databaseUrl: trimToNull(process.env.MAD_DATABASE_URL),
  requestTimeoutMs: toPositiveInt(process.env.MADEIRA_REQUEST_TIMEOUT_MS, 8000),
  freightMaxResponseMs: 1500,
  freightRequiredAvailability: 85,
  databaseProvider: "neon-postgres",
};

function buildPublicConfigSnapshot() {
  return {
    moduleName: env.moduleName,
    runtimeEnvironment: env.runtimeEnvironment,
    coreBaseUrl: env.coreBaseUrl,
    requestTimeoutMs: env.requestTimeoutMs,
    freightMaxResponseMs: env.freightMaxResponseMs,
    freightRequiredAvailability: env.freightRequiredAvailability,
    databaseProvider: env.databaseProvider,
    readiness: {
      coreApi: Boolean(env.coreBaseUrl),
      database: Boolean(env.databaseUrl),
      messagingApi: Boolean(env.coreBaseUrl),
    },
    credentials: {
      apiTokenConfigured: Boolean(env.apiToken),
      databaseConfigured: Boolean(env.databaseUrl),
    },
  };
}

module.exports = {
  ...env,
  buildPublicConfigSnapshot,
};
