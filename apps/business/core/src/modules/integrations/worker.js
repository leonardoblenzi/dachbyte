"use strict";

const os = require("os");
const crypto = require("crypto");
const db = require("../../../db/db");
const logger = require("../../observability/logger");
const { runJobBatch, recoverStaleJobs } = require("./jobEngine");
const { runOutboxBatch, recoverStaleOutbox } = require("./outboxEngine");
const { pruneIntegrationHistory } = require("./maintenance");
const { resolveWorkerConfig } = require("./workerConfig");
const { onIntegrationQueueWake } = require("./workerSignal");

function createWorkerId() {
  return `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString("hex")}`;
}

function createIntegrationWorker(options = {}) {
  const workerId = options.workerId || createWorkerId();
  const environment = options.environment || process.env;
  const config = resolveWorkerConfig(environment, options);
  const { pollMs, idleMaxMs, idleBackoffFactor, jitterRatio, batchSize, outboxBatchSize, leaseMs, recoveryEveryMs, maintenanceEveryMs } = config;
  const timers = options.timers || { setTimeout, clearTimeout };
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const databaseEnabled = options.databaseEnabled || db.isDatabaseEnabled;
  const recoverJobs = options.recoverJobs || recoverStaleJobs;
  const recoverOutbox = options.recoverOutbox || recoverStaleOutbox;
  const maintain = options.maintain || pruneIntegrationHistory;
  const runJobs = options.runJobs || runJobBatch;
  const runOutbox = options.runOutbox || runOutboxBatch;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
  const unrefTimer = options.unrefTimer !== false;
  let timer = null;
  let activeRun = null;
  let running = false;
  let scheduledCycleActive = false;
  let started = false;
  let stopped = false;
  let wakeRequested = false;
  let removeWakeListener = null;
  let currentPollMs = pollMs;
  let idleCycles = 0;
  let nextRunAt = null;
  let lastRunAt = null;
  let lastRecoveryAt = null;
  let lastMaintenanceAt = null;
  let lastError = null;

  function isoNow() { return new Date(now()).toISOString(); }

  function runOnce() {
    if (running || stopped || !databaseEnabled()) return Promise.resolve({ skipped: true });
    running = true;
    const execution = (async () => {
      try {
        lastRunAt = isoNow();
        if (!lastRecoveryAt || now() - new Date(lastRecoveryAt).getTime() >= recoveryEveryMs) {
          await recoverJobs(leaseMs);
          await recoverOutbox(leaseMs);
          lastRecoveryAt = isoNow();
        }
        if (!lastMaintenanceAt || now() - new Date(lastMaintenanceAt).getTime() >= maintenanceEveryMs) {
          await maintain();
          lastMaintenanceAt = isoNow();
        }
        const jobs = await runJobs(workerId, batchSize);
        const outbox = await runOutbox(workerId, outboxBatchSize);
        lastError = null;
        return { jobs: jobs.length, outbox: outbox.length };
      } catch (error) {
        lastError = { code: error?.code, message: error?.message, at: isoNow() };
        logger.error("integration.worker.error", { workerId, errorCode: error?.code, error });
        return { error: lastError };
      } finally { running = false; }
    })();
    activeRun = execution;
    void execution.finally(() => { if (activeRun === execution) activeRun = null; });
    return execution;
  }

  function jittered(base) {
    if (!jitterRatio) return base;
    const multiplier = 1 + ((random() * 2) - 1) * jitterRatio;
    return Math.max(0, Math.round(base * multiplier));
  }

  function schedule(delay) {
    if (!started || stopped) return;
    if (timer) timers.clearTimeout(timer);
    currentPollMs = delay;
    nextRunAt = new Date(now() + delay).toISOString();
    timer = timers.setTimeout(() => {
      timer = null;
      nextRunAt = null;
      return runScheduledCycle();
    }, delay);
    if (unrefTimer) timer.unref?.();
  }

  function nextDelay(result) {
    const worked = Number(result?.jobs || 0) + Number(result?.outbox || 0) > 0;
    if (worked || result?.error) {
      idleCycles = 0;
      return pollMs;
    }
    idleCycles += 1;
    const base = Math.min(idleMaxMs, Math.max(pollMs, currentPollMs || pollMs) * idleBackoffFactor);
    return Math.min(idleMaxMs, Math.max(pollMs, jittered(base)));
  }

  async function finishScheduledCycle(runPromise) {
    try {
      const result = await runPromise;
      if (!started || stopped) return result;
      if (wakeRequested) {
        wakeRequested = false;
        schedule(0);
      } else {
        schedule(nextDelay(result));
      }
      return result;
    } finally { scheduledCycleActive = false; }
  }

  function runScheduledCycle() {
    scheduledCycleActive = true;
    return finishScheduledCycle(runOnce());
  }

  function start() {
    if (started || stopped) return Promise.resolve({ skipped: true, reason: stopped ? "stopped" : "already_started" });
    if (String(environment.VOLT_CORE_WORKER_DISABLED || "").toLowerCase() === "true") return Promise.resolve({ skipped: true, reason: "disabled" });
    started = true;
    removeWakeListener = onIntegrationQueueWake(wake);
    logger.info("integration.worker.started", { workerId, pollMs, idleMaxMs, idleBackoffFactor, jitterRatio, batchSize, outboxBatchSize, leaseMs, recoveryEveryMs, maintenanceEveryMs });
    scheduledCycleActive = true;
    const firstRun = runOnce();
    void finishScheduledCycle(firstRun);
    return firstRun;
  }

  function wake() {
    if (!started || stopped) return false;
    if (running || scheduledCycleActive) {
      wakeRequested = true;
      return true;
    }
    schedule(0);
    return true;
  }

  async function waitForActiveRun() {
    const execution = activeRun;
    if (!execution) return false;
    let deadlineTimer = null;
    const deadline = new Promise((resolve) => { deadlineTimer = timers.setTimeout(() => resolve(true), shutdownTimeoutMs); });
    try { return await Promise.race([execution.then(() => false), deadline]); }
    finally { if (deadlineTimer) timers.clearTimeout(deadlineTimer); }
  }

  async function stop() {
    stopped = true;
    started = false;
    wakeRequested = false;
    removeWakeListener?.();
    removeWakeListener = null;
    if (timer) timers.clearTimeout(timer);
    timer = null;
    nextRunAt = null;
    const timedOut = await waitForActiveRun();
    logger.info("integration.worker.stopped", { workerId, timedOut, shutdownTimeoutMs });
  }

  function status() {
    return { workerId, started, running, stopped, pollMs, idleMaxMs, currentPollMs, idleCycles, nextRunAt, batchSize, outboxBatchSize, leaseMs, recoveryEveryMs, maintenanceEveryMs, lastRunAt, lastRecoveryAt, lastMaintenanceAt, lastError };
  }

  return { runOnce, start, status, stop, wake, workerId };
}

let singleton = null;
function getIntegrationWorker() {
  if (!singleton) singleton = createIntegrationWorker();
  return singleton;
}

module.exports = { createIntegrationWorker, getIntegrationWorker };
