"use strict";

// Worker do DACH Hub: processa a fila hub-import (BullMQ). Precisa de HUB_REDIS_URL/REDIS_URL.
const path = require("node:path");
const { loadRuntimeEnv } = require("../../lib/runtimeEnv");

loadRuntimeEnv({
  defaultCandidates: [
    path.join(__dirname, ".env"),
    path.join(__dirname, "..", ".env"),
  ],
});

const { createContainer } = require("./src/container");
const { startImportWorker } = require("./src/jobs/importQueue");

const { config, db, imports } = createContainer();
if (!config.redisUrl) {
  console.error("[seller-hub:worker] HUB_REDIS_URL/REDIS_URL não configurado.");
  process.exit(1);
}

const handle = startImportWorker({ redisUrl: config.redisUrl, run: (job) => imports.runImport(job) });
console.log("[seller-hub:worker] processando a fila de importação");

async function shutdown() {
  await handle.close().catch(() => {});
  await db.close().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
