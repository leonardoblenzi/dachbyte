"use strict";

const { assertApplicationRoleSecurity, pool } = require("../db/db");
const logger = require("../src/observability/logger");
const { createIntegrationWorker } = require("../src/modules/integrations/worker");

async function main() {
  await assertApplicationRoleSecurity();
  const worker = createIntegrationWorker({ unrefTimer: false });
  worker.start();

  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    logger.info("integration.worker_process.shutdown", { signal });
    await worker.stop();
    if (pool) await pool.end();
    process.exit(0);
  }

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  logger.info("integration.worker_process.ready", { workerId: worker.workerId });
}

main().catch((error) => {
  logger.error("integration.worker_process.start_failed", { error });
  process.exit(1);
});
