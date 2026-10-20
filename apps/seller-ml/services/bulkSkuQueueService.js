"use strict";

const Bull = require("bull");
const { makeBullClient } = require("../lib/redisClient");
const { applyJob, settleJobCredits } = require("./bulkSkuService");
const { runExport } = require("./bulkSkuExportService");
const { runPreview } = require("./bulkSkuPreviewJobService");

const QUEUE_NAME = "bulk-sku-queue";
let queueInstance = null;
let workerStarted = false;
let settlementTimer = null;

async function reconcilePendingSettlements(db = require("../db/db")) {
  const jobs = await db.query(`select id from ml.bulk_sku_jobs
    where status in ('finished', 'failed') and credit_reservation is not null
      and coalesce((credit_reservation->>'bypass')::boolean, false) = false
      and coalesce((credit_reservation->>'shadow')::boolean, false) = false
      and (credit_settlement is null or credit_settlement->>'status' = 'pending')
    order by finished_at limit 100`);
  for (const job of jobs.rows) {
    try { await settleJobCredits(job.id, db); }
    catch (error) { console.error("[BulkSkuQueue] Conciliacao de creditos:", job.id, error?.message || error); }
  }
}

async function reconcileQueuedApplications(db = require("../db/db"), enqueue = enqueueBulkSkuJob) {
  const jobs = await db.query(`select id from ml.bulk_sku_jobs
    where status = 'queued' and credit_reservation is not null
    order by created_at limit 100`);
  for (const job of jobs.rows) {
    try { await enqueue(job.id); }
    catch (error) { console.error("[BulkSkuQueue] Reenfileirar lote:", job.id, error?.message || error); }
  }
}

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
        } else if (job.name === "bulk-sku-apply") {
          await settleJobCredits(job.data.jobId, db);
        }
      }
    } catch (databaseError) { console.error("[BulkSkuQueue] Falha ao registrar erro:", databaseError?.message || databaseError); }
    console.error("[BulkSkuQueue] Lote falhou:", job?.id, error?.message || error);
  });
  reconcilePendingSettlements().catch((error) => console.error("[BulkSkuQueue] Conciliacao inicial:", error?.message || error));
  reconcileQueuedApplications().catch((error) => console.error("[BulkSkuQueue] Fila inicial:", error?.message || error));
  settlementTimer = setInterval(() => {
    reconcilePendingSettlements().catch((error) => console.error("[BulkSkuQueue] Conciliacao:", error?.message || error));
    reconcileQueuedApplications().catch((error) => console.error("[BulkSkuQueue] Reenfileirar:", error?.message || error));
  }, 60_000);
  settlementTimer.unref?.();
  return queue;
}

module.exports = { enqueueBulkSkuJob, enqueueExportJob, enqueuePreviewJob, reconcilePendingSettlements, reconcileQueuedApplications, initWorker };
