"use strict";

function invalid(name, value, minimum, maximum) {
  const error = new Error(`${name} must be a number between ${minimum} and ${maximum}; received: ${value}.`);
  error.code = "WORKER_CONFIG_INVALID";
  return error;
}

function numberSetting(environment, name, fallback, minimum, maximum, options = {}) {
  const raw = environment[name];
  if (raw == null || String(raw).trim() === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum || (options.integer && !Number.isInteger(parsed))) {
    throw invalid(name, raw, minimum, maximum);
  }
  return parsed;
}

function resolveWorkerConfig(environment = process.env, overrides = {}) {
  const merged = {
    ...environment,
    VOLT_CORE_JOB_POLL_MS: overrides.pollMs ?? environment.VOLT_CORE_JOB_POLL_MS,
    VOLT_CORE_WORKER_IDLE_MAX_MS: overrides.idleMaxMs ?? environment.VOLT_CORE_WORKER_IDLE_MAX_MS,
    VOLT_CORE_WORKER_IDLE_BACKOFF_FACTOR: overrides.idleBackoffFactor ?? environment.VOLT_CORE_WORKER_IDLE_BACKOFF_FACTOR,
    VOLT_CORE_WORKER_JITTER_RATIO: overrides.jitterRatio ?? environment.VOLT_CORE_WORKER_JITTER_RATIO,
    VOLT_CORE_JOB_BATCH_SIZE: overrides.batchSize ?? environment.VOLT_CORE_JOB_BATCH_SIZE,
    VOLT_CORE_OUTBOX_BATCH_SIZE: overrides.outboxBatchSize ?? environment.VOLT_CORE_OUTBOX_BATCH_SIZE,
    VOLT_CORE_JOB_LEASE_MS: overrides.leaseMs ?? environment.VOLT_CORE_JOB_LEASE_MS,
    VOLT_CORE_JOB_RECOVERY_MS: overrides.recoveryEveryMs ?? environment.VOLT_CORE_JOB_RECOVERY_MS,
    VOLT_CORE_INTEGRATION_MAINTENANCE_MS: overrides.maintenanceEveryMs ?? environment.VOLT_CORE_INTEGRATION_MAINTENANCE_MS
  };
  const pollMs = numberSetting(merged, "VOLT_CORE_JOB_POLL_MS", 3000, 500, 300000, { integer: true });

  return {
    pollMs,
    idleMaxMs: numberSetting(merged, "VOLT_CORE_WORKER_IDLE_MAX_MS", Math.max(600000, pollMs), pollMs, 900000, { integer: true }),
    idleBackoffFactor: numberSetting(merged, "VOLT_CORE_WORKER_IDLE_BACKOFF_FACTOR", 2, 1, 10),
    jitterRatio: numberSetting(merged, "VOLT_CORE_WORKER_JITTER_RATIO", 0.15, 0, 0.5),
    batchSize: numberSetting(merged, "VOLT_CORE_JOB_BATCH_SIZE", 10, 1, 1000, { integer: true }),
    outboxBatchSize: numberSetting(merged, "VOLT_CORE_OUTBOX_BATCH_SIZE", 20, 1, 1000, { integer: true }),
    leaseMs: numberSetting(merged, "VOLT_CORE_JOB_LEASE_MS", 300000, 30000, 86400000, { integer: true }),
    recoveryEveryMs: numberSetting(merged, "VOLT_CORE_JOB_RECOVERY_MS", 60000, 30000, 86400000, { integer: true }),
    maintenanceEveryMs: numberSetting(merged, "VOLT_CORE_INTEGRATION_MAINTENANCE_MS", 21600000, 3600000, 604800000, { integer: true })
  };
}

module.exports = { numberSetting, resolveWorkerConfig };
