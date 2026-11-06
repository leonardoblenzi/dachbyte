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
const { startSyncWorkers } = require("./src/jobs/syncQueues");

const container = createContainer();
const { config, db, imports, orders, sync, reconcile, billing, automations, labels } = container;
if (!config.redisUrl) {
  console.error("[seller-hub:worker] HUB_REDIS_URL/REDIS_URL não configurado.");
  process.exit(1);
}

const handle = startImportWorker({ redisUrl: config.redisUrl, run: (job) => imports.runImport(job) });
/** @type {any} */
let syncHandle = null;
startSyncWorkers({
  redisUrl: config.redisUrl,
  handlers: {
    push: (accountId) => sync.processAccount(accountId),
    webhook: (eventId) => orders.processWebhook(eventId),
    pollAll: async () => {
      for (const account of await container.db.query("select id from hub.channel_accounts where status = 'connected' order by id").then((/** @type {any} */ r) => r.rows)) {
        try { await orders.pollAccount(Number(account.id)); } catch (error) { console.error("[seller-hub:poll]", account.id, /** @type {any} */ (error)?.message); }
      }
    },
    reconcile: (job) => reconcile.runReconcile(job),
    reconcileAll: () => reconcile.scheduleAll(),
    closeMonths: async () => ({ ...(await billing.closePastMonths()), labelsRemoved: await labels.cleanup() }),
    automation: (job) => automations.onOrderEvent(job),
    automationsScan: () => automations.scanDue(),
  },
}).then((h) => { syncHandle = h; console.log("[seller-hub:worker] processando importação, pedidos, envios de estoque e conferências"); })
  .catch((error) => { console.error("[seller-hub:worker] filas da E3 não iniciaram", error); process.exit(1); });

async function shutdown() {
  await handle.close().catch(() => {});
  if (syncHandle) await syncHandle.close().catch(() => {});
  await container.syncQueues.close().catch(() => {});
  await db.close().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
