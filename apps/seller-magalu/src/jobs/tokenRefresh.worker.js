"use strict";

const { Worker } = require("bullmq");
const queueNames = require("../config/queueNames");
const env = require("../config/env");
const { createRedisConnection } = require("../config/redis");
const tokenRepository = require("../repositories/tokenRepository");
const accountRepository = require("../repositories/accountRepository");
const { refreshAccount } = require("../services/magaluTokenService");
const { enqueueTokenRefresh } = require("../queues/magaluQueue");
const { recordBestEffort, errorDetails } = require("../services/auditService");

let worker = null;
let workerConnection = null;
let sweepTimer = null;

async function enqueueExpiringAccounts() {
  const cutoff = new Date(Date.now() + Math.max(120, env.MAGALU_TOKEN_REFRESH_SKEW_SECONDS) * 1000);
  const accountIds = await tokenRepository.findAccountsNeedingRefresh({ before: cutoff, limit: 200 });
  for (const accountId of accountIds) {
    try {
      await enqueueTokenRefresh(accountId);
    } catch (error) {
      const message = String(error?.message || error);
      if (!/job.*exist|already exists|jobId/i.test(message)) {
        console.warn("[seller-magalu-worker] enqueue token refresh", { accountId, message });
      }
    }
  }
  return accountIds.length;
}

async function processTokenRefreshJob(job) {
  const accountId = Number(job.data?.accountId);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    throw new Error("Job de refresh Magalu sem accountId válido.");
  }

  const account = await accountRepository.findAccountById(accountId).catch(() => null);
  try {
    const result = await refreshAccount(accountId);
    await recordBestEffort({
      eventKey: "token_refreshed",
      source: "worker",
      accountId,
      dachTenantId: account?.dach_tenant_id || null,
      magaluTenantId: account?.magalu_tenant_id || null,
      details: {
        job_id: job.id || null,
        access_expires_at: result.accessExpiresAt || null,
        scope_count: Array.isArray(result.scopes) ? result.scopes.length : null,
      },
    });
    return {
      accountId,
      refreshedAt: new Date().toISOString(),
      accessExpiresAt: result.accessExpiresAt || null,
    };
  } catch (error) {
    await recordBestEffort({
      eventKey: "token_refresh_failed",
      source: "worker",
      outcome: "failed",
      severity: "error",
      accountId,
      dachTenantId: account?.dach_tenant_id || null,
      magaluTenantId: account?.magalu_tenant_id || null,
      requestId: error?.requestId || null,
      details: { job_id: job.id || null, error: errorDetails(error) },
    });
    throw error;
  }
}

async function startTokenRefreshWorker() {
  if (worker) return worker;
  const connection = await createRedisConnection();
  workerConnection = connection;
  worker = new Worker(
    queueNames.tokenRefresh,
    processTokenRefreshJob,
    { connection, concurrency: 2 },
  );
  worker.on("failed", (job, error) => {
    console.error("[seller-magalu-worker] token refresh failed", {
      accountId: job?.data?.accountId || null,
      attemptsMade: job?.attemptsMade || 0,
      message: error?.message || String(error),
    });
  });

  await enqueueExpiringAccounts().catch((error) => {
    console.warn("[seller-magalu-worker] initial token sweep failed", error?.message || error);
  });
  sweepTimer = setInterval(() => {
    void enqueueExpiringAccounts().catch((error) => {
      console.warn("[seller-magalu-worker] token sweep failed", error?.message || error);
    });
  }, 5 * 60 * 1000);
  sweepTimer.unref?.();
  return worker;
}

async function stopTokenRefreshWorker() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  if (worker) await worker.close().catch(() => {});
  worker = null;
  if (workerConnection) workerConnection.disconnect();
  workerConnection = null;
}

module.exports = {
  startTokenRefreshWorker,
  stopTokenRefreshWorker,
  enqueueExpiringAccounts,
  _test: { processTokenRefreshJob },
};
