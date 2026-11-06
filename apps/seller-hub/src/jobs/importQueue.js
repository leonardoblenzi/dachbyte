// @ts-check
"use strict";

/** Nome da fila no Redis (prefixo hub- para não misturar com as filas dos módulos DACH). */
const IMPORT_QUEUE = "hub-import";

/** @typedef {import("../modules/imports/service").ImportJob} ImportJob */
/** @typedef {import("../modules/imports/service").ImportQueue} ImportQueue */

/** @param {string} redisUrl */
function redisConnection(redisUrl) {
  const { Redis } = require("ioredis");
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
  connection.on("error", (error) => console.error("[seller-hub:redis]", error?.message || error));
  return connection;
}

/**
 * Fila de importação.
 * - Com Redis (HUB_REDIS_URL/REDIS_URL): BullMQ, processada pelo worker (`npm run worker`).
 * - Sem Redis: roda no próprio processo, em segundo plano (desenvolvimento e prévia local).
 * @param {{ redisUrl: string, runInline: (job: ImportJob) => Promise<unknown> }} options
 * @returns {ImportQueue}
 */
function createImportQueue({ redisUrl, runInline }) {
  if (!redisUrl) {
    return {
      mode: "inline",
      async enqueue(job) {
        setImmediate(() => { runInline(job).catch((error) => console.error("[seller-hub:import]", job.runId, error?.message || error)); });
      },
    };
  }
  const { Queue } = require("bullmq");
  const connection = redisConnection(redisUrl);
  const queue = new Queue(IMPORT_QUEUE, {
    connection,
    // Sem nova tentativa automática: a execução fica "falhou" e o seller tenta de novo pelo botão.
    defaultJobOptions: { attempts: 1, removeOnComplete: 200, removeOnFail: 500 },
  });
  return {
    mode: "bullmq",
    async enqueue(job) { await queue.add("import", job, { jobId: `import-${job.runId}` }); },
    async close() { await queue.close(); await connection.quit().catch(() => {}); },
  };
}

/**
 * Worker BullMQ que executa as importações.
 * @param {{ redisUrl: string, run: (job: ImportJob) => Promise<unknown>, concurrency?: number }} options
 */
function startImportWorker({ redisUrl, run, concurrency = 2 }) {
  const { Worker } = require("bullmq");
  const connection = redisConnection(redisUrl);
  const worker = new Worker(IMPORT_QUEUE, async (job) => run(/** @type {ImportJob} */ (job.data)), { connection, concurrency });
  worker.on("failed", (job, error) => console.error("[seller-hub:worker] importação falhou", job?.data?.runId, error?.message));
  worker.on("completed", (job, result) => console.log("[seller-hub:worker] importação concluída", job?.data?.runId, JSON.stringify(result)));
  return {
    worker,
    async close() { await worker.close(); await connection.quit().catch(() => {}); },
  };
}

module.exports = { IMPORT_QUEUE, createImportQueue, startImportWorker };
