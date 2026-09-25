"use strict";

const { Worker } = require("bullmq");
const { ensureRedisConnected } = require("../config/redis");
const queueNames = require("../config/queueNames");
const { cleanup } = require("../services/auditRetentionService");

let worker = null;

async function processAuditMaintenanceJob(job) {
  if (!job || String(job.name || "") !== "cleanup") throw new Error(`Job de auditoria Magalu desconhecido: ${job?.name || ""}`);
  return cleanup({ mode:"scheduled", actorUserId:null });
}
async function startAuditMaintenanceWorker() {
  if (worker) return worker;
  const connection = await ensureRedisConnected();
  worker = new Worker(queueNames.auditMaintenance, processAuditMaintenanceJob, { connection, concurrency:1 });
  worker.on("failed", (job,error) => console.error("[seller-magalu:audit-maintenance] job failed", { job:job?.id||null, message:error?.message||String(error) }));
  return worker;
}
async function stopAuditMaintenanceWorker() { if (!worker) return; const current=worker; worker=null; await current.close(); }
module.exports = { startAuditMaintenanceWorker, stopAuditMaintenanceWorker, _test:{processAuditMaintenanceJob} };
