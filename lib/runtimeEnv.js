"use strict";

const fs = require("fs");
const path = require("path");

function resolveDotenv() {
  const candidates = [
    "dotenv",
    path.resolve(process.cwd(), "node_modules", "dotenv"),
    path.resolve(__dirname, "..", "node_modules", "dotenv"),
    path.resolve(__dirname, "..", "ml", "node_modules", "dotenv"),
  ];

  for (const mod of candidates) {
    try {
      return require(mod);
    } catch (_error) {}
  }

  return null;
}

function isProductionEnvironment() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function resolveExplicitEnvPath() {
  const raw =
    process.env.APP_ENV_FILE ||
    process.env.ML_ENV_FILE ||
    process.env.DOTENV_CONFIG_PATH ||
    "";

  const trimmed = String(raw || "").trim();
  return trimmed ? path.resolve(trimmed) : null;
}

function resolveExistingPath(candidates = []) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const absolute = path.resolve(candidate);
    if (fs.existsSync(absolute)) return absolute;
  }
  return null;
}

function loadRuntimeEnv(options = {}) {
  if (isProductionEnvironment()) {
    return { loaded: false, source: null, skipped: "production" };
  }

  const explicitPath = resolveExplicitEnvPath();
  const defaultCandidates = Array.isArray(options.defaultCandidates)
    ? options.defaultCandidates
    : [];

  const envPath = explicitPath || resolveExistingPath(defaultCandidates);
  if (!envPath) {
    return {
      loaded: false,
      source: null,
      skipped: explicitPath ? "explicit_path_missing" : "no_env_file",
    };
  }

  const dotenv = resolveDotenv();
  if (!dotenv || typeof dotenv.config !== "function") {
    return {
      loaded: false,
      source: envPath,
      skipped: "dotenv_module_missing",
      explicit: !!explicitPath,
    };
  }

  dotenv.config({ path: envPath });

  return {
    loaded: true,
    source: envPath,
    explicit: !!explicitPath,
  };
}

module.exports = {
  isProductionEnvironment,
  loadRuntimeEnv,
};
