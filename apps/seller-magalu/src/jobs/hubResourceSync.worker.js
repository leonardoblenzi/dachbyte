"use strict";

const { Worker } = require("bullmq");
const { ensureRedisConnected } = require("../config/redis");
const queueNames = require("../config/queueNames");
const accountRepository = require("../repositories/accountRepository");
const { syncHubResource } = require("../services/hubResourceSyncService");
const { enqueueHubResourceSync } = require("../queues/magaluQueue");

let worker = null;
let reconciliationTimer = null;

function localResourceKey(account) {
  const tenantId = String(account?.magalu_tenant_id || "").trim();
  if (!tenantId) throw new Error("Conta Magalu sem tenant para chave de recurso Hub.");
  return `magalu:${tenantId}`;
}

async function processHubResourceSyncJob(job) {
  const accountId = Number(job?.data?.accountId);
  if (!Number.isFinite(accountId) || accountId <= 0) throw new Error("Job de recurso Hub Magalu sem accountId válido.");
  const account = await accountRepository.findAccountById(accountId);
  if (!account) throw new Error("Conta Magalu não encontrada para sincronização de recurso Hub.");
  await accountRepository.setHubResourceSyncState(accountId, { status: "syncing", error: null });
  try {
    await syncHubResource(account);
    const resourceKey = localResourceKey(account);
    const syncedAt = new Date();
    await accountRepository.setHubResourceSyncState(accountId, { status: "synced", hubResourceKey: resourceKey, syncedAt, error: null });
    return { accountId, resourceKey, syncedAt: syncedAt.toISOString() };
  } catch (error) {
    await accountRepository.setHubResourceSyncState(accountId, { status: "failed", error: String(error?.message || error).slice(0, 2000) }).catch(() => {});
    throw error;
  }
}

async function enqueuePendingHubResourceSyncs() {
  const accounts = await accountRepository.listHubResourceSyncCandidates({ limit: 100 });
  for (const account of accounts) {
    const job = await enqueueHubResourceSync(account.id);
    if (job.scheduled) await accountRepository.markHubResourceSyncQueuedIfPending(account.id);
  }
  return accounts.length;
}

async function startHubResourceSyncWorker() {
  if (worker) return worker;
  const connection = await ensureRedisConnected();
  worker = new Worker(queueNames.hubResourceSync, processHubResourceSyncJob, { connection, concurrency: 2 });
  worker.on("failed", (job, error) => console.error("[seller-magalu:hub-resource-worker] job failed", { accountId: job?.data?.accountId || null, message: error?.message || String(error) }));
  await enqueuePendingHubResourceSyncs().catch((error) => console.warn("[seller-magalu:hub-resource-worker] reconciliation failed", error?.message || error));
  reconciliationTimer = setInterval(() => {
    void enqueuePendingHubResourceSyncs().catch((error) => console.warn("[seller-magalu:hub-resource-worker] reconciliation failed", error?.message || error));
  }, 5 * 60 * 1000);
  reconciliationTimer.unref?.();
  return worker;
}

async function stopHubResourceSyncWorker() {
  if (reconciliationTimer) clearInterval(reconciliationTimer);
  reconciliationTimer = null;
  if (!worker) return;
  const current = worker;
  worker = null;
  await current.close();
}

module.exports = { startHubResourceSyncWorker, stopHubResourceSyncWorker, _test: { processHubResourceSyncJob, enqueuePendingHubResourceSyncs } };
