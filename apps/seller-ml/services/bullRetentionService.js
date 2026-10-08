"use strict";

const crypto = require("crypto");
const Bull = require("bull");
const { getSharedRedis, makeBullClient } = require("../lib/redisClient");

const DEFAULT_COMPLETED_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 60 * 1000;
const DEFAULT_CLEAN_LIMIT = 500;
const DEFAULT_MAX_BATCHES = 4;
const LOCK_KEY = "ml:bull-retention:v1:lock";

const BASE_QUEUE_NAMES = [
  "prazo-producao-queue",
  "financeiro-ml-sku-catalog-sync",
  "validar-dimensoes",
  "ml-exclusao-lote",
  "ml-atacado",
  "ml-modelo-massa",
  "ml-caracteristicas",
  "estoque-alerta-queue",
  "estoque-atualizacao-queue",
  "promo-jobs",
  "promo-smart-optimizer",
  "ml-promo-bulk-remove",
  "meli-webhook-notifications",
];

let intervalHandle = null;
let initialHandle = null;
const queueCache = new Map();

function intFromEnv(name, fallback, min, max) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(raw)));
}

function boolFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(value)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(value)) return false;
  return fallback;
}

function getRetentionPolicy() {
  return {
    enabled: boolFromEnv("ML_BULL_RETENTION_ENABLED", true),
    completedRetentionMs: intFromEnv(
      "ML_BULL_COMPLETED_RETENTION_MS",
      DEFAULT_COMPLETED_RETENTION_MS,
      60_000,
      90 * 24 * 60 * 60 * 1000,
    ),
    failedRetentionMs: intFromEnv(
      "ML_BULL_FAILED_RETENTION_MS",
      DEFAULT_FAILED_RETENTION_MS,
      60_000,
      180 * 24 * 60 * 60 * 1000,
    ),
    intervalMs: intFromEnv(
      "ML_BULL_CLEAN_INTERVAL_MS",
      DEFAULT_INTERVAL_MS,
      60_000,
      7 * 24 * 60 * 60 * 1000,
    ),
    initialDelayMs: intFromEnv(
      "ML_BULL_CLEAN_INITIAL_DELAY_MS",
      DEFAULT_INITIAL_DELAY_MS,
      1_000,
      60 * 60 * 1000,
    ),
    cleanLimit: intFromEnv(
      "ML_BULL_CLEAN_LIMIT",
      DEFAULT_CLEAN_LIMIT,
      10,
      10_000,
    ),
    maxBatches: intFromEnv(
      "ML_BULL_CLEAN_MAX_BATCHES",
      DEFAULT_MAX_BATCHES,
      1,
      50,
    ),
  };
}

function getManagedQueueNames() {
  const filtroQueue =
    String(process.env.FILTRO_ANUNCIOS_QUEUE_NAME || "").trim() ||
    "Filtro Anuncios Export Queue v3";
  const extras = String(process.env.ML_BULL_EXTRA_QUEUES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return [...new Set([...BASE_QUEUE_NAMES, filtroQueue, ...extras])];
}

function getQueue(name) {
  if (!queueCache.has(name)) {
    queueCache.set(
      name,
      new Bull(name, {
        createClient: (type) => makeBullClient(type, `retention:${name}`),
      }),
    );
  }
  return queueCache.get(name);
}

async function acquireCleanupLock(ttlMs) {
  const redis = getSharedRedis("app");
  const token = `${process.pid}:${Date.now()}:${crypto.randomBytes(8).toString("hex")}`;
  const result = await redis.set(LOCK_KEY, token, "PX", ttlMs, "NX");
  return result === "OK" ? { redis, token } : null;
}

async function releaseCleanupLock(lock) {
  if (!lock?.redis || !lock?.token) return;
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `;
  await lock.redis.eval(script, 1, LOCK_KEY, lock.token).catch(() => {});
}

async function cleanState(queue, graceMs, status, policy) {
  let removed = 0;
  for (let batch = 0; batch < policy.maxBatches; batch += 1) {
    const ids = await queue.clean(graceMs, status, policy.cleanLimit);
    const count = Array.isArray(ids) ? ids.length : 0;
    removed += count;
    if (count < policy.cleanLimit) break;
  }
  return removed;
}

async function runBullRetentionCleanup(options = {}) {
  const policy = { ...getRetentionPolicy(), ...(options.policy || {}) };
  if (!policy.enabled) {
    return { ok: true, skipped: true, reason: "disabled", queues: [] };
  }

  const queueNames = options.queueNames || getManagedQueueNames();
  const lockTtl = Math.max(60_000, Math.min(policy.intervalMs, 30 * 60 * 1000));
  const lock = await acquireCleanupLock(lockTtl);
  if (!lock) {
    return { ok: true, skipped: true, reason: "lock_busy", queues: [] };
  }

  const summary = [];
  try {
    for (const queueName of queueNames) {
      try {
        const queue = getQueue(queueName);
        const completed = await cleanState(
          queue,
          policy.completedRetentionMs,
          "completed",
          policy,
        );
        const failed = await cleanState(
          queue,
          policy.failedRetentionMs,
          "failed",
          policy,
        );
        summary.push({ queue: queueName, completed, failed });
      } catch (error) {
        summary.push({
          queue: queueName,
          completed: 0,
          failed: 0,
          error: error?.message || String(error),
        });
      }
    }
  } finally {
    await releaseCleanupLock(lock);
  }

  const removedTotal = summary.reduce(
    (sum, row) => sum + Number(row.completed || 0) + Number(row.failed || 0),
    0,
  );
  if (removedTotal > 0) {
    console.log(
      `[ML Bull Retention] limpeza concluida: ${removedTotal} job(s) antigo(s) removido(s).`,
    );
  }
  return { ok: true, skipped: false, removedTotal, queues: summary };
}

function startBullRetentionScheduler() {
  const policy = getRetentionPolicy();
  if (!policy.enabled) {
    console.log("[ML Bull Retention] desativado por configuracao.");
    return { started: false, reason: "disabled" };
  }
  if (intervalHandle || initialHandle) {
    return { started: false, reason: "already_started" };
  }

  const execute = () => {
    runBullRetentionCleanup().catch((error) => {
      console.error(
        "[ML Bull Retention] falha na limpeza:",
        error?.message || error,
      );
    });
  };

  initialHandle = setTimeout(() => {
    initialHandle = null;
    execute();
    intervalHandle = setInterval(execute, policy.intervalMs);
    intervalHandle.unref?.();
  }, policy.initialDelayMs);
  initialHandle.unref?.();

  console.log(
    `[ML Bull Retention] agendado (completed=${policy.completedRetentionMs}ms, failed=${policy.failedRetentionMs}ms, interval=${policy.intervalMs}ms).`,
  );
  return { started: true };
}

async function stopBullRetentionScheduler() {
  if (initialHandle) clearTimeout(initialHandle);
  if (intervalHandle) clearInterval(intervalHandle);
  initialHandle = null;
  intervalHandle = null;

  const queues = [...queueCache.values()];
  queueCache.clear();
  await Promise.allSettled(
    queues.map((queue) => (typeof queue.close === "function" ? queue.close() : null)),
  );
}

module.exports = {
  getManagedQueueNames,
  getRetentionPolicy,
  runBullRetentionCleanup,
  startBullRetentionScheduler,
  stopBullRetentionScheduler,
  _test: {
    BASE_QUEUE_NAMES,
  },
};
