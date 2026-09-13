const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveWorkerConfig } = require("./workerConfig");
const { createIntegrationWorker } = require("./worker");
const { notifyIntegrationQueue, onIntegrationQueueWake } = require("./workerSignal");
const db = require("../../../db/db");
const logger = require("../../observability/logger");
const { enqueueJob, enqueueJobWithClient, retryJob } = require("./jobStore");
const { enqueueOutboxEvent, insertOutboxEventWithClient, retryOutbox } = require("./outboxStore");

function fakeTimers() {
  let nextId = 1;
  const scheduled = new Map();

  return {
    scheduled,
    setTimeout(callback, delay) {
      const timer = { id: nextId++, unref() {} };
      scheduled.set(timer.id, { callback, delay, timer });
      return timer;
    },
    clearTimeout(timer) {
      scheduled.delete(timer?.id);
    },
    async runNext() {
      const next = scheduled.entries().next();
      assert.equal(next.done, false, "expected a scheduled worker cycle");
      const [id, item] = next.value;
      scheduled.delete(id);
      await item.callback();
      return item.delay;
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function workerOptions(overrides = {}) {
  return {
    environment: {},
    workerId: "adaptive-test",
    pollMs: 1000,
    idleMaxMs: 4000,
    idleBackoffFactor: 2,
    jitterRatio: 0,
    databaseEnabled: () => true,
    recoverJobs: async () => null,
    recoverOutbox: async () => null,
    maintain: async () => null,
    runJobs: async () => [],
    runOutbox: async () => [],
    now: () => Date.parse("2026-08-14T12:00:00Z"),
    ...overrides
  };
}

function fakeTransactionalClient(order, { failInsert = false } = {}) {
  return {
    async query(sql) {
      const statement = String(sql).trim().toLowerCase();
      if (statement === "begin" || statement === "commit" || statement === "rollback") {
        order.push(statement);
        return { rows: [], rowCount: 0 };
      }
      order.push("insert");
      if (failInsert) throw new Error("insert failed");
      return { rows: [{ id: "persisted-record" }], rowCount: 1 };
    }
  };
}

test("queue wake listeners can unsubscribe and one failing listener does not block the others", (t) => {
  let notifications = 0;
  const removeFailing = onIntegrationQueueWake(() => {
    throw new Error("listener failed");
  });
  const removeCounting = onIntegrationQueueWake(() => {
    notifications += 1;
  });
  t.after(() => {
    removeFailing();
    removeCounting();
  });

  assert.doesNotThrow(() => notifyIntegrationQueue());
  assert.equal(notifications, 1);

  removeFailing();
  removeCounting();
  notifyIntegrationQueue();
  assert.equal(notifications, 1);
});

test("queue wake notification uses a snapshot when a listener removes and re-registers itself", (t) => {
  let calls = 0;
  let reRegistered = false;
  let removeCurrent = () => {};
  const listener = () => {
    calls += 1;
    removeCurrent();
    if (!reRegistered) {
      reRegistered = true;
      removeCurrent = onIntegrationQueueWake(listener);
    }
  };
  removeCurrent = onIntegrationQueueWake(listener);
  t.after(() => removeCurrent());

  notifyIntegrationQueue();
  assert.equal(calls, 1);

  notifyIntegrationQueue();
  assert.equal(calls, 2);
});

test("enqueueJob notifies only after its transaction commits", async (t) => {
  const order = [];
  const originalWithClient = db.withClient;
  db.withClient = async (operation) => operation(fakeTransactionalClient(order));
  const removeWakeListener = onIntegrationQueueWake(() => order.push("notify"));
  t.after(() => {
    removeWakeListener();
    db.withClient = originalWithClient;
  });

  const job = await enqueueJob("company-test", { type: "test.job" });

  assert.equal(job.id, "persisted-record");
  assert.deepEqual(order, ["begin", "insert", "commit", "notify"]);
});

test("enqueueOutboxEvent notifies only after its transaction commits", async (t) => {
  const order = [];
  const originalWithClient = db.withClient;
  db.withClient = async (operation) => operation(fakeTransactionalClient(order));
  const removeWakeListener = onIntegrationQueueWake(() => order.push("notify"));
  t.after(() => {
    removeWakeListener();
    db.withClient = originalWithClient;
  });

  const event = await enqueueOutboxEvent("company-test", "test.event", { probe: true });

  assert.equal(event.id, "persisted-record");
  assert.deepEqual(order, ["begin", "insert", "commit", "notify"]);
});

test("failed enqueue transactions roll back without notifying the worker", async (t) => {
  const originalWithClient = db.withClient;
  let notifications = 0;
  const removeWakeListener = onIntegrationQueueWake(() => {
    notifications += 1;
  });
  t.after(() => {
    removeWakeListener();
    db.withClient = originalWithClient;
  });

  for (const enqueue of [
    () => enqueueJob("company-test", { type: "test.job" }),
    () => enqueueOutboxEvent("company-test", "test.event", { probe: true })
  ]) {
    const order = [];
    db.withClient = async (operation) => operation(fakeTransactionalClient(order, { failInsert: true }));
    await assert.rejects(enqueue, /insert failed/);
    assert.deepEqual(order, ["begin", "insert", "rollback"]);
  }
  assert.equal(notifications, 0);
});

test("with-client enqueue helpers leave wake notification to the transaction owner", async () => {
  const order = [];
  let notifications = 0;
  const client = fakeTransactionalClient(order);
  const removeWakeListener = onIntegrationQueueWake(() => {
    notifications += 1;
  });
  try {
    await enqueueJobWithClient(client, "company-test", { type: "test.job" });
    await insertOutboxEventWithClient(client, "company-test", "test.event", { probe: true });
  } finally {
    removeWakeListener();
  }

  assert.deepEqual(order, ["insert", "insert"]);
  assert.equal(notifications, 0);
});

test("successful manual retries wake the worker after the durable update", async (t) => {
  const originalQuery = db.query;
  const order = [];
  db.query = async () => {
    order.push("update");
    return { rowCount: 1, rows: [{ id: "retry-record" }] };
  };
  const removeWakeListener = onIntegrationQueueWake(() => order.push("notify"));
  t.after(() => {
    removeWakeListener();
    db.query = originalQuery;
  });

  const retriedJob = await retryJob("company-test", "job-test", "user-test");
  const retriedOutbox = await retryOutbox("company-test", "outbox-test");

  assert.equal(retriedJob.id, "retry-record");
  assert.equal(retriedOutbox.id, "retry-record");
  assert.deepEqual(order, ["update", "notify", "update", "notify"]);
});

test("manual retries that update no record do not wake the worker", async (t) => {
  const originalQuery = db.query;
  let notifications = 0;
  db.query = async () => ({ rowCount: 0, rows: [] });
  const removeWakeListener = onIntegrationQueueWake(() => {
    notifications += 1;
  });
  t.after(() => {
    removeWakeListener();
    db.query = originalQuery;
  });

  await assert.rejects(() => retryJob("company-test", "missing-job", "user-test"), {
    code: "INTEGRATION_JOB_NOT_RETRYABLE"
  });
  await assert.rejects(() => retryOutbox("company-test", "missing-outbox"), {
    code: "OUTBOX_EVENT_NOT_RETRYABLE"
  });
  assert.equal(notifications, 0);
});

test("resolveWorkerConfig returns the worker defaults", () => {
  assert.deepEqual(resolveWorkerConfig({}), {
    pollMs: 3000,
    idleMaxMs: 600000,
    idleBackoffFactor: 2,
    jitterRatio: 0.15,
    batchSize: 10,
    outboxBatchSize: 20,
    leaseMs: 300000,
    recoveryEveryMs: 60000,
    maintenanceEveryMs: 21600000
  });
});

test("resolveWorkerConfig supports VOLT_CORE_JOB_POLL_MS as a poll alias", () => {
  assert.equal(resolveWorkerConfig({ VOLT_CORE_JOB_POLL_MS: "1250" }).pollMs, 1250);
});

test("resolveWorkerConfig permits zero jitter and treats empty values as absent", () => {
  assert.equal(resolveWorkerConfig({}, { jitterRatio: 0 }).jitterRatio, 0);
  assert.equal(resolveWorkerConfig({ VOLT_CORE_JOB_POLL_MS: "" }).pollMs, 3000);
});

test("resolveWorkerConfig preserves the Neon idle floor for larger active poll intervals", () => {
  assert.equal(resolveWorkerConfig({}, { pollMs: 120000 }).idleMaxMs, 600000);
});

test("resolveWorkerConfig rejects invalid environment values", () => {
  const cases = [
    ["VOLT_CORE_JOB_POLL_MS", "Infinity"],
    ["VOLT_CORE_WORKER_IDLE_MAX_MS", "499"],
    ["VOLT_CORE_WORKER_IDLE_BACKOFF_FACTOR", "10.1"],
    ["VOLT_CORE_WORKER_JITTER_RATIO", "0.51"],
    ["VOLT_CORE_JOB_BATCH_SIZE", "1.5"],
    ["VOLT_CORE_OUTBOX_BATCH_SIZE", "1001"],
    ["VOLT_CORE_JOB_LEASE_MS", "29999"],
    ["VOLT_CORE_JOB_RECOVERY_MS", "NaN"],
    ["VOLT_CORE_INTEGRATION_MAINTENANCE_MS", "604800001"]
  ];

  for (const [name, value] of cases) {
    assert.throws(() => resolveWorkerConfig({ [name]: value }), { code: "WORKER_CONFIG_INVALID" });
  }
});

test("resolveWorkerConfig validates overrides without bypassing limits", () => {
  const cases = [
    { pollMs: 499 },
    { idleMaxMs: 2999 },
    { idleBackoffFactor: 0.99 },
    { jitterRatio: -0.01 },
    { batchSize: 0 },
    { outboxBatchSize: 1000.5 },
    { leaseMs: 86400001 },
    { recoveryEveryMs: 30000.5 },
    { maintenanceEveryMs: 3599999 }
  ];

  for (const overrides of cases) {
    assert.throws(() => resolveWorkerConfig({}, overrides), { code: "WORKER_CONFIG_INVALID" });
  }
});

test("empty cycles back off to the idle ceiling and work resets the delay", async () => {
  const timers = fakeTimers();
  let jobs = 0;
  const worker = createIntegrationWorker(workerOptions({
    timers,
    runJobs: async () => Array.from({ length: jobs })
  }));

  await worker.start();
  assert.equal(timers.scheduled.size, 1);
  assert.equal(worker.status().currentPollMs, 2000);
  assert.equal(worker.status().idleCycles, 1);
  assert.equal(worker.status().nextRunAt, "2026-08-14T12:00:02.000Z");

  assert.equal(await timers.runNext(), 2000);
  assert.equal(worker.status().currentPollMs, 4000);
  assert.equal(worker.status().idleCycles, 2);

  assert.equal(await timers.runNext(), 4000);
  assert.equal(worker.status().currentPollMs, 4000);
  assert.equal(worker.status().idleCycles, 3);

  jobs = 1;
  assert.equal(await timers.runNext(), 4000);
  assert.equal(worker.status().currentPollMs, 1000);
  assert.equal(worker.status().idleCycles, 0);
  assert.equal(worker.status().idleMaxMs, 4000);

  await worker.stop();
});

test("jitter changes idle scheduling without exceeding the configured ceiling", async () => {
  const timers = fakeTimers();
  const worker = createIntegrationWorker(workerOptions({
    timers,
    jitterRatio: 0.25,
    random: () => 1
  }));

  await worker.start();
  assert.equal(worker.status().currentPollMs, 2500);
  await timers.runNext();
  assert.equal(worker.status().currentPollMs, 4000);
  await worker.stop();
});

test("errors reset scheduling to the active poll interval", async () => {
  const timers = fakeTimers();
  let fail = false;
  const worker = createIntegrationWorker(workerOptions({
    timers,
    runJobs: async () => {
      if (fail) throw Object.assign(new Error("queue failed"), { code: "QUEUE_FAILED" });
      return [];
    }
  }));

  await worker.start();
  assert.equal(worker.status().currentPollMs, 2000);
  fail = true;
  await timers.runNext();
  assert.equal(worker.status().currentPollMs, 1000);
  assert.equal(worker.status().idleCycles, 0);
  assert.equal(worker.status().lastError.code, "QUEUE_FAILED");
  await worker.stop();
});

test("wake replaces the idle timer and the shared signal is removed on stop", async () => {
  const timers = fakeTimers();
  const worker = createIntegrationWorker(workerOptions({ timers }));

  await worker.start();
  assert.equal(timers.scheduled.size, 1);
  assert.equal(worker.wake(), true);
  assert.equal(timers.scheduled.size, 1);
  assert.equal([...timers.scheduled.values()][0].delay, 0);

  await timers.runNext();
  assert.equal(timers.scheduled.size, 1);
  notifyIntegrationQueue();
  assert.equal(timers.scheduled.size, 1);
  assert.equal([...timers.scheduled.values()][0].delay, 0);

  await worker.stop();
  assert.equal(timers.scheduled.size, 0);
  notifyIntegrationQueue();
  assert.equal(timers.scheduled.size, 0);
  assert.equal(worker.wake(), false);
});

test("wake during a running cycle schedules one immediate follow-up without overlap", async () => {
  const timers = fakeTimers();
  const firstBatch = deferred();
  let activeRuns = 0;
  let maximumActiveRuns = 0;
  let runCount = 0;
  const worker = createIntegrationWorker(workerOptions({
    timers,
    runJobs: async () => {
      runCount += 1;
      activeRuns += 1;
      maximumActiveRuns = Math.max(maximumActiveRuns, activeRuns);
      if (runCount === 1) await firstBatch.promise;
      activeRuns -= 1;
      return [];
    }
  }));

  const startPromise = worker.start();
  while (runCount === 0) await Promise.resolve();
  assert.equal(worker.status().running, true);
  assert.equal(worker.wake(), true);
  assert.equal(worker.wake(), true);
  assert.equal(timers.scheduled.size, 0);
  assert.equal(runCount, 1);

  firstBatch.resolve();
  await startPromise;
  assert.equal(timers.scheduled.size, 1);
  assert.equal([...timers.scheduled.values()][0].delay, 0);
  await timers.runNext();
  assert.equal(runCount, 2);
  assert.equal(maximumActiveRuns, 1);
  await worker.stop();
});

test("wake after work settles but before rescheduling preserves one immediate cycle", async () => {
  const timers = fakeTimers();
  let runCount = 0;
  let activeRuns = 0;
  let maximumActiveRuns = 0;
  const originalLoggerError = logger.error;
  logger.error = () => queueMicrotask(notifyIntegrationQueue);
  const worker = createIntegrationWorker(workerOptions({
    timers,
    runJobs: async () => {
      runCount += 1;
      activeRuns += 1;
      maximumActiveRuns = Math.max(maximumActiveRuns, activeRuns);
      activeRuns -= 1;
      if (runCount === 1) throw new Error("boundary failure");
      return [];
    }
  }));

  try {
    await worker.start();
    assert.equal(runCount, 1);
    assert.equal(timers.scheduled.size, 1);
    assert.equal([...timers.scheduled.values()][0].delay, 0);

    await timers.runNext();
    assert.equal(runCount, 2);
    assert.equal(maximumActiveRuns, 1);
    assert.equal(timers.scheduled.size, 1);
    assert.equal([...timers.scheduled.values()][0].delay, 2000);
  } finally {
    logger.error = originalLoggerError;
    await worker.stop();
  }
});

test("stop cancels the timer and awaits the running cycle", async () => {
  const timers = fakeTimers();
  const batch = deferred();
  const worker = createIntegrationWorker(workerOptions({
    timers,
    runJobs: async () => batch.promise
  }));

  const startPromise = worker.start();
  await Promise.resolve();
  let stopped = false;
  const stopPromise = worker.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.equal(timers.scheduled.size, 1);
  assert.equal([...timers.scheduled.values()][0].delay, 10000);

  batch.resolve([]);
  await Promise.all([startPromise, stopPromise]);
  assert.equal(stopped, true);
  assert.equal(timers.scheduled.size, 0);
  assert.equal(worker.status().nextRunAt, null);
});

test("stop returns after ten seconds when the running cycle does not settle", async () => {
  const timers = fakeTimers();
  const batch = deferred();
  const worker = createIntegrationWorker(workerOptions({
    timers,
    runJobs: async () => batch.promise
  }));

  const startPromise = worker.start();
  while (!worker.status().running) await Promise.resolve();
  let stopped = false;
  const stopPromise = worker.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();

  assert.equal(stopped, false);
  assert.equal(timers.scheduled.size, 1);
  assert.equal([...timers.scheduled.values()][0].delay, 10000);
  await timers.runNext();
  await stopPromise;
  assert.equal(stopped, true);
  assert.equal(timers.scheduled.size, 0);
  assert.equal(worker.status().running, true);

  batch.resolve([]);
  await startPromise;
  assert.equal(timers.scheduled.size, 0);
});

test("disabled workers preserve the public skipped start contract", async () => {
  const timers = fakeTimers();
  const worker = createIntegrationWorker(workerOptions({
    environment: { VOLT_CORE_WORKER_DISABLED: "true" },
    timers
  }));

  assert.deepEqual(await worker.start(), { skipped: true, reason: "disabled" });
  assert.equal(worker.status().started, false);
  assert.equal(timers.scheduled.size, 0);
  await worker.stop();
});