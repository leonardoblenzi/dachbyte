"use strict";

function isProduction(env = process.env) {
  return String(env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function hasConfiguredHubMode(env = process.env) {
  return Boolean(
    String(env.ML_HUB_GATE_MODE || "").trim() ||
      String(env.HUB_AUTH_MODE || "").trim() ||
      String(env.HUB_ENFORCEMENT || "").trim(),
  );
}

function applyRuntimeSecurityDefaults(env = process.env) {
  const changes = [];

  if (isProduction(env) && !hasConfiguredHubMode(env)) {
    env.HUB_AUTH_MODE = "strict";
    env.ML_HUB_GATE_MODE = "strict";
    changes.push("hub_strict_default");
  }

  if (env.ML_BOOTSTRAP_MASTER == null) {
    env.ML_BOOTSTRAP_MASTER = "false";
    changes.push("master_bootstrap_default_off");
  }

  return { production: isProduction(env), changes };
}

module.exports = {
  applyRuntimeSecurityDefaults,
  hasConfiguredHubMode,
  isProduction,
};
