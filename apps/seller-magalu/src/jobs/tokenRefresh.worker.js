"use strict";

const { Worker } = require("bullmq");
const queueNames = require("../config/queueNames");
const env = require("../config/env");
const { createRedisConnection } = require("../config/redis");
const tokenRepository = require("../repositories/tokenRepository");
const { refreshAccount } = require("../services/magaluTokenService");
const { enqueueTokenRefresh } = require("../queues/magaluQueue");

let worker = null;
let workerConnection = null;
let sweepTimer = null;

async function enqueueExpiringAccounts() {
  const cutoff = new Date(Date.now() + Math.max(120, env.MAGALU_TOKEN_REFRESH_SKEW_SECONDS) * 1000);
  const accountIds = await tokenRepository.findAccountsNeedingRefresh({ before: cutoff, limit: 200 });
  for (const accountId of accountIds) {
    try {
      // jobId por conta evita duplicidade entre sweeps concorrentes.
      // eslint-disable-next-line no-await-in-loop
      await enqueueTokenRefresh(accountId);
    } catch (error) {
      const message = String(error?.message || error);
      // Job duplicado já presente na fila não é falha operacional.
      if (!/job.*exist|already exists|jobId/i.test(message)) {
        console.warn("[seller-magalu-worker] enqueue token refresh", { accountId, message });
      }
    }
  }
  return accountIds.length;
}

async function startTokenRefreshWorker() {
  if (worker) return worker;
  const connection = await createRedisConnection();
  workerConnection = connection;
  worker = new Worker(
    queueNames.tokenRefresh,
    async (job) => {
      const accountId = Number(job.data?.accountId);
      if (!Number.isFinite(accountId) || accountId <= 0) throw new Error("Job de refresh Magalu sem accountId válido.");
      const result = await refreshAccount(accountId);
      return {
        accountId,
        refreshedAt: new Date().toISOString(),
        accessExpiresAt: result.accessExpiresAt || null,
      };
    },
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

module.exports = { startTokenRefreshWorker, stopTokenRefreshWorker, enqueueExpiringAccounts };
