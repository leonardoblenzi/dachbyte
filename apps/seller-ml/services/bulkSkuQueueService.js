"use strict";

const Bull = require("bull");
const { makeBullClient } = require("../lib/redisClient");
const { applyJob } = require("./bulkSkuService");

const QUEUE_NAME = "bulk-sku-queue";
let queueInstance = null;
let workerStarted = false;

function getQueue() {
  if (!queueInstance) {
    queueInstance = new Bull(QUEUE_NAME, { createClient: (type) => makeBullClient(type, QUEUE_NAME) });
    queueInstance.on("error", (error) => console.error("[BulkSkuQueue]", error?.message || error));
  }
  return queueInstance;
}

async function enqueueBulkSkuJob(jobId, queue = getQueue()) {
  const id = String(jobId || "").trim();
  if (!id) throw new Error("ID do lote obrigatorio.");
  return queue.add("bulk-sku-apply", { jobId: id }, { jobId: id, attempts: 3, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 100, removeOnFail: 100 });
}

function initWorker(queue = getQueue()) {
  if (workerStarted) return queue;
  workerStarted = true;
  queue.process("bulk-sku-apply", 1, async (job) => applyJob(job.data.jobId, { onProgress: (value) => job.progress(value) }));
  queue.on("failed", async (job, error) => {
    if (Number(job?.attemptsMade || 0) < Number(job?.opts?.attempts || 1)) return;
    try {
      const db = require("../db/db");
      await db.query("update ml.bulk_sku_jobs set status = 'failed', finished_at = now() where id = $1 and status in ('queued', 'running')", [job.data.jobId]);
    } catch (databaseError) { console.error("[BulkSkuQueue] Falha ao registrar erro:", databaseError?.message || databaseError); }
    console.error("[BulkSkuQueue] Lote falhou:", job?.id, error?.message || error);
  });
  return queue;
}

module.exports = { enqueueBulkSkuJob, initWorker };
