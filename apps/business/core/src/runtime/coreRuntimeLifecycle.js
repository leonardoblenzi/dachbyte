"use strict";

const { assertApplicationRoleSecurity, pool } = require("../../db/db");
const { ensureMasterUser } = require("../modules/auth/authService");
const { getIntegrationWorker } = require("../modules/integrations/worker");
const logger = require("../observability/logger");

let started = false;
let startedAt = null;
let startedBy = null;
let startPromise = null;
let stopPromise = null;
let processHooksRegistered = false;
let poolClosed = false;

function registerProcessHooks() {
  if (processHooksRegistered) return;
  processHooksRegistered = true;

  const stopFromSignal = (signal) => {
    void stopCoreRuntime({ closePool: true, reason: signal }).catch((error) => {
      logger.error("core.runtime.shutdown_error", { signal, error });
    });
  };

  process.once("SIGTERM", () => stopFromSignal("SIGTERM"));
  process.once("SIGINT", () => stopFromSignal("SIGINT"));
}

function getCoreRuntimeStatus() {
  return {
    started,
    startedAt,
    startedBy,
    worker: getIntegrationWorker().status(),
  };
}

async function startCoreRuntime(options = {}) {
  if (started) return getCoreRuntimeStatus();
  if (startPromise) return startPromise;

  const source = String(options.source || "embedded").trim() || "embedded";
  startPromise = (async () => {
    await assertApplicationRoleSecurity();
    await ensureMasterUser();

    const worker = getIntegrationWorker();
    // O primeiro ciclo e disparado imediatamente, mas nao bloqueia o startup do web server.
    // Isso evita que um handler externo lento torne o deploy indisponivel.
    void worker.start();

    started = true;
    startedAt = new Date().toISOString();
    startedBy = source;

    if (options.registerProcessHooks !== false) registerProcessHooks();

    logger.info("core.runtime.started", {
      source,
      workerStarted: worker.status().started,
      workerLastRunAt: worker.status().lastRunAt,
    });
    return getCoreRuntimeStatus();
  })();

  try {
    return await startPromise;
  } finally {
    startPromise = null;
  }
}

async function stopCoreRuntime(options = {}) {
  if (stopPromise) return stopPromise;

  stopPromise = (async () => {
    const worker = getIntegrationWorker();
    await worker.stop();

    if (options.closePool === true && pool && !poolClosed) {
      await pool.end();
      poolClosed = true;
    }

    const previousStartedBy = startedBy;
    started = false;
    logger.info("core.runtime.stopped", {
      source: previousStartedBy,
      reason: options.reason || "requested",
      poolClosed: options.closePool === true,
    });
    return getCoreRuntimeStatus();
  })();

  try {
    return await stopPromise;
  } finally {
    stopPromise = null;
  }
}

module.exports = {
  getCoreRuntimeStatus,
  startCoreRuntime,
  stopCoreRuntime,
};
