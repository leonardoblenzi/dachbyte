"use strict";

const { Worker } = require("bullmq");
const { ensureRedisConnected } = require("../config/redis");
const queueNames = require("../config/queueNames");
const accountRepository = require("../repositories/accountRepository");
const { fullCatalogSync, reconcileSku } = require("../services/catalogSyncService");
const { recordBestEffort, errorDetails } = require("../services/auditService");

let worker = null;

async function processCatalogJob(job) {
  if (job.name === "full-sync") {
    const account = await accountRepository.findAccountById(job.data.accountId);
    if (!account) throw new Error("Conta Magalu não encontrada para full-sync.");
    if (job.data.dachTenantId && String(account.dach_tenant_id) !== String(job.data.dachTenantId)) {
      const error = new Error("Tenant DACH divergente no job de catálogo Magalu.");
      error.code = "MAGALU_SYNC_TENANT_MISMATCH";
      throw error;
    }

    await recordBestEffort({
      eventKey: "catalog_sync_started",
      source: "worker",
      accountId: account.id,
      dachTenantId: account.dach_tenant_id,
      magaluTenantId: account.magalu_tenant_id,
      details: { job_id: job.id || null, reason: job.data.reason || "queue" },
    });

    try {
      const result = await fullCatalogSync(account.id, {
        reason: job.data.reason || "queue",
        jobId: job.id,
      });
      await recordBestEffort({
        eventKey: "catalog_sync_completed",
        source: "worker",
        accountId: account.id,
        dachTenantId: account.dach_tenant_id,
        magaluTenantId: account.magalu_tenant_id,
        details: {
          job_id: job.id || null,
          status: result?.status || "success",
          scanned: result?.scanned ?? null,
          created: result?.created ?? null,
          updated: result?.updated ?? null,
          failed: result?.failed ?? null,
          pages: result?.pages ?? null,
        },
      });
      return result;
    } catch (error) {
      await recordBestEffort({
        eventKey: "catalog_sync_failed",
        source: "worker",
        outcome: "failed",
        severity: "error",
        accountId: account.id,
        dachTenantId: account.dach_tenant_id,
        magaluTenantId: account.magalu_tenant_id,
        requestId: error?.requestId || null,
        details: { job_id: job.id || null, error: errorDetails(error) },
      });
      throw error;
    }
  }

  if (job.name === "reconcile-sku") {
    return reconcileSku(job.data.accountId, job.data.sku, {
      topic: job.data.topic || "manual",
    });
  }

  throw new Error(`Job de catálogo Magalu desconhecido: ${job.name}`);
}

async function startCatalogSyncWorker() {
  if (worker) return worker;
  const connection = await ensureRedisConnected();
  worker = new Worker(queueNames.catalogSync, processCatalogJob, {
    connection,
    concurrency: 1,
  });
  worker.on("failed", (job, error) =>
    console.error("[seller-magalu:catalog-worker] job failed", {
      job: job?.id || null,
      name: job?.name || null,
      message: error?.message || String(error),
    }),
  );
  return worker;
}

async function stopCatalogSyncWorker() {
  if (!worker) return;
  const current = worker;
  worker = null;
  await current.close();
}

module.exports = {
  startCatalogSyncWorker,
  stopCatalogSyncWorker,
  _test: { processCatalogJob },
};
