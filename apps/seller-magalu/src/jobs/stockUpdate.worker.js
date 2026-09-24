"use strict";

const { Worker } = require("bullmq");
const { ensureRedisConnected } = require("../config/redis");
const queueNames = require("../config/queueNames");
const { executeOperation } = require("../services/writeExecutionService");

let worker = null;

async function processStockUpdateJob(job) {
  if (!job || !["apply", "verify"].includes(String(job.name || ""))) {
    throw new Error(`Job de estoque Magalu desconhecido: ${job?.name || ""}`);
  }
  return executeOperation(job.data.operationId);
}

async function startStockUpdateWorker() {
  if (worker) return worker;
  const connection = await ensureRedisConnected();
  worker = new Worker(queueNames.stockUpdate, processStockUpdateJob, {
    connection,
    concurrency: 2,
  });
  worker.on("failed", (job, error) =>
    console.error("[seller-magalu:stock-worker] job failed", {
      job: job?.id || null,
      name: job?.name || null,
      reason: job?.data?.reason || null,
      attemptsMade: job?.attemptsMade ?? null,
      message: error?.message || String(error),
    }),
  );
  return worker;
}

async function stopStockUpdateWorker() {
  if (!worker) return;
  const current = worker;
  worker = null;
  await current.close();
}

module.exports = {
  startStockUpdateWorker,
  stopStockUpdateWorker,
  _test: { processStockUpdateJob },
};
