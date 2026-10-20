"use strict";

const Bull = require("bull");
const { makeBullClient } = require("../lib/redisClient");
const { applyJob } = require("./bulkSkuService");
const { runExport } = require("./bulkSkuExportService");
const { runPreview } = require("./bulkSkuPreviewJobService");

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

async function enqueueExportJob(jobId, queue = getQueue()) {
  return queue.add("bulk-sku-export", { jobId }, { jobId: `export-${jobId}`, attempts: 1, removeOnComplete: 100, removeOnFail: 100 });
}

async function enqueuePreviewJob(jobId, queue = getQueue()) {
  return queue.add("bulk-sku-preview", { jobId }, { jobId: `preview-${jobId}`, attempts: 1, removeOnComplete: 100, removeOnFail: 100 });
}

function initWorker(queue = getQueue()) {
  if (workerStarted) return queue;
  workerStarted = true;
  queue.process("bulk-sku-apply", 1, async (job) => applyJob(job.data.jobId, { onProgress: (value) => job.progress(value) }));
  queue.process("bulk-sku-export", 1, async (job) => runExport(job.data.jobId, { onProgress: (value) => job.progress(value) }));
  queue.process("bulk-sku-preview", 1, async (job) => runPreview(job.data.jobId, { onProgress: (value) => job.progress(value) }));
  queue.on("failed", async (job, error) => {
    if (Number(job?.attemptsMade || 0) < Number(job?.opts?.attempts || 1)) return;
    try {
      const db = require("../db/db");
      if (job.name === "bulk-sku-export") await db.query("update ml.bulk_sku_exports set status = 'failed', finished_at = now(), error_message = $2 where id = $1 and status in ('queued', 'running')", [job.data.jobId, String(error?.message || "Falha na exportacao").slice(0, 500)]);
      else {
        await db.query("update ml.bulk_sku_jobs set status = 'failed', finished_at = now(), error_message = $2 where id = $1 and status in ('preview_queued', 'previewing', 'queued', 'running')", [job.data.jobId, String(error?.message || "Falha no lote").slice(0, 500)]);
        if (job.name === "bulk-sku-preview") {
          const fs = require("node:fs");
          const { importPath } = require("./bulkSkuPreviewJobService");
          try { fs.unlinkSync(importPath(job.data.jobId)); } catch (_) {}
        }
      }
    } catch (databaseError) { console.error("[BulkSkuQueue] Falha ao registrar erro:", databaseError?.message || databaseError); }
    console.error("[BulkSkuQueue] Lote falhou:", job?.id, error?.message || error);
  });
  return queue;
}

module.exports = { enqueueBulkSkuJob, enqueueExportJob, enqueuePreviewJob, initWorker };
