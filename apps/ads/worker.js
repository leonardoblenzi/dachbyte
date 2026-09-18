"use strict";

const crypto = require("node:crypto");
const { env } = require("./config/env");
const { getRedis, closeRedis } = require("./infrastructure/redis/client");
const { getWorkerPool, closePools } = require("./infrastructure/db/pool");
const { GoogleAdsSyncRepository } = require("./infrastructure/google/googleAdsSyncRepository");
const { GoogleAdsSyncService } = require("./application/google/googleAdsSyncService");
const { MetaAdsSyncRepository } = require("./infrastructure/meta/metaAdsSyncRepository");
const { MetaAdsSyncService } = require("./application/meta/metaAdsSyncService");

if (!env.redisUrl) throw new Error("REDIS_URL is required for the DACH Ads worker");
if (!env.workerDatabaseUrl) throw new Error("ADS_WORKER_DATABASE_URL is required for the DACH Ads worker");

const workerId = `ads-worker-${crypto.randomUUID().slice(0, 8)}`;
const redis = getRedis();
const pool = getWorkerPool();
const processors = [
  {
    provider: "google_ads",
    repository: new GoogleAdsSyncRepository(pool),
    service: null,
  },
  {
    provider: "meta_ads",
    repository: new MetaAdsSyncRepository(pool),
    service: null,
  },
];
processors[0].service = new GoogleAdsSyncService(processors[0].repository);
processors[1].service = new MetaAdsSyncService(processors[1].repository);

let heartbeatTimer;
let pollTimer;
let polling = false;
let shuttingDown = false;
let providerCursor = 0;

async function heartbeat() {
  const payload = JSON.stringify({ ts: Date.now(), app: "dach-ads-worker", version: 4, workerId });
  await redis.set(env.workerHeartbeatKey, payload, "EX", env.workerHeartbeatTtlSeconds);
}

async function processProvider(processor) {
  const job = await processor.repository.claimDueJob(workerId, env.syncJobLockMinutes);
  if (!job) return false;
  try {
    const result = await processor.service.syncJob(job);
    console.log("[dach-ads-worker] sync processed", {
      provider: processor.provider,
      accountId: job.ad_account_id,
      tenantId: job.tenant_id,
      result,
    });
  } catch (error) {
    console.error("[dach-ads-worker] sync failed", {
      provider: processor.provider,
      accountId: job.ad_account_id,
      tenantId: job.tenant_id,
      code: error.code,
      message: error.message,
    });
  }
  return true;
}

async function processOneJob() {
  for (let offset = 0; offset < processors.length; offset += 1) {
    const index = (providerCursor + offset) % processors.length;
    const processor = processors[index];
    if (await processProvider(processor)) {
      providerCursor = (index + 1) % processors.length;
      return true;
    }
  }
  return false;
}

async function poll() {
  if (polling || shuttingDown) return;
  polling = true;
  try {
    for (let count = 0; count < 4 && !shuttingDown; count += 1) {
      const processed = await processOneJob();
      if (!processed) break;
    }
  } catch (error) {
    console.error("[dach-ads-worker] poll failed", error);
  } finally { polling = false; }
}

async function boot() {
  await heartbeat();
  heartbeatTimer = setInterval(() => {
    heartbeat().catch((error) => console.error("[dach-ads-worker] heartbeat failed", error));
  }, 10_000);
  heartbeatTimer.unref();

  await poll();
  pollTimer = setInterval(() => void poll(), env.syncWorkerPollMs);
  pollTimer.unref();
  console.log(`[dach-ads-worker] started (${workerId}) providers=google_ads,meta_ads`);
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[dach-ads-worker] received ${signal}, shutting down`);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (pollTimer) clearInterval(pollTimer);
  const deadline = Date.now() + 20_000;
  while (polling && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await Promise.all([closeRedis(), closePools()]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => console.error("[dach-ads-worker] unhandled rejection", reason));
process.on("uncaughtException", (error) => {
  console.error("[dach-ads-worker] uncaught exception", error);
  process.exit(1);
});

void boot();
