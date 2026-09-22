const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_MAINTENANCE_INTERVAL_MS,
  MIN_MAINTENANCE_INTERVAL_MS,
  createAuthAuditPartitionScheduler,
  resolveMaintenanceInterval,
} = require("../services/authAuditPartitionScheduler");

function partitionedService(calls, { inspect = { partitioned: true } } = {}) {
  return {
    async inspectCurrentTable() { calls.push("inspect"); return inspect; },
    async ensurePartitions() { calls.push("ensure"); return { applied: true }; },
    async drainDefaultPartition() { calls.push("drain"); return { applied: true, moved: 0 }; },
    async pruneExpiredPartitions(options) { calls.push(["prune", options]); return { applied: true, dryRun: true }; },
    async verifyPartitionedAudit() { calls.push("verify"); return { defaultDrained: true }; },
  };
}

test("resolve intervalo diario por padrao, respeita minimo e permite desativar", () => {
  assert.deepEqual(resolveMaintenanceInterval({}), { enabled: true, intervalMs: DEFAULT_MAINTENANCE_INTERVAL_MS });
  assert.deepEqual(resolveMaintenanceInterval({ env: { AUTH_AUDIT_PARTITION_MAINTENANCE_INTERVAL_MS: "1" } }), {
    enabled: true,
    intervalMs: MIN_MAINTENANCE_INTERVAL_MS,
  });
  assert.deepEqual(resolveMaintenanceInterval({ env: { AUTH_AUDIT_PARTITION_MAINTENANCE_INTERVAL_MS: "0" } }), {
    enabled: false,
    intervalMs: 0,
  });
  assert.deepEqual(resolveMaintenanceInterval({ env: { AUTH_AUDIT_PARTITION_MAINTENANCE_INTERVAL_MS: "false" } }), {
    enabled: false,
    intervalMs: 0,
  });
});

test("antes do corte registra skip e nao executa mutacoes", async () => {
  const calls = [];
  const logs = [];
  const scheduler = createAuthAuditPartitionScheduler({
    service: partitionedService(calls, { inspect: { partitioned: false, relkind: "r" } }),
    logger: { info: (...args) => logs.push(args), error() {} },
  });

  const result = await scheduler.run();
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "parent_not_partitioned");
  assert.deepEqual(calls, ["inspect"]);
  assert.match(String(logs[0][0]), /ainda nao esta particionada/i);
});

test("pos-corte aplica retencao configurada, mantem remocao de particoes em dry-run e verifica na ordem", async () => {
  const calls = [];
  const logs = [];
  const scheduler = createAuthAuditPartitionScheduler({
    service: partitionedService(calls),
    logger: { info: (...args) => logs.push(args), error() {} },
  });

  const result = await scheduler.run();
  assert.equal(result.skipped, false);
  assert.deepEqual(calls, ["inspect", "ensure", "drain", ["prune", { confirmDrop: false }], "verify"]);
  assert.match(String(logs[0][0]), /Limpeza de retencao aplicada/i);
  assert.match(String(logs[0][0]), /remocao de particoes permanece em dry-run/i);
});

test("falhas nao escapam do scheduler e a proxima tentativa continua possivel", async () => {
  let attempts = 0;
  const errors = [];
  const scheduler = createAuthAuditPartitionScheduler({
    service: {
      async inspectCurrentTable() {
        attempts += 1;
        if (attempts === 1) throw new Error("database temporarily unavailable");
        return { partitioned: false };
      },
    },
    logger: { info() {}, error: (...args) => errors.push(args) },
  });

  const failed = await scheduler.run();
  const retried = await scheduler.run();
  assert.equal(failed.failed, true);
  assert.equal(retried.reason, "parent_not_partitioned");
  assert.equal(attempts, 2);
  assert.match(String(errors[0][0]), /falhou/i);
  assert.match(String(errors[0][1]), /database temporarily unavailable/);
});

test("single-flight impede execucoes sobrepostas", async () => {
  let resolveInspect;
  let inspectCalls = 0;
  const scheduler = createAuthAuditPartitionScheduler({
    service: {
      inspectCurrentTable() {
        inspectCalls += 1;
        return new Promise((resolve) => { resolveInspect = resolve; });
      },
      async ensurePartitions() {}, async drainDefaultPartition() {}, async pruneExpiredPartitions() {}, async verifyPartitionedAudit() {},
    },
    logger: { info() {}, error() {} },
  });

  const first = scheduler.run();
  const second = scheduler.run();
  assert.strictEqual(first, second);
  resolveInspect({ partitioned: false });
  await first;
  assert.equal(inspectCalls, 1);
});

test("start executa uma vez, agenda sem prender processo e stop limpa o timer", async () => {
  const calls = [];
  let scheduled = null;
  let cleared = null;
  const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const scheduler = createAuthAuditPartitionScheduler({
    service: partitionedService(calls, { inspect: { partitioned: false } }),
    logger: { info() {}, error() {} },
    env: { AUTH_AUDIT_PARTITION_MAINTENANCE_INTERVAL_MS: "60000" },
    setIntervalFn: (fn, delay) => { scheduled = { fn, delay }; return timer; },
    clearIntervalFn: (value) => { cleared = value; },
  });

  const started = scheduler.start();
  await started.initialRun;
  assert.equal(scheduled.delay, MIN_MAINTENANCE_INTERVAL_MS);
  assert.equal(timer.unrefCalled, true);
  started.stop();
  assert.strictEqual(cleared, timer);
});

test("start reutiliza o timer da mesma instancia", async () => {
  let timers = 0;
  const scheduler = createAuthAuditPartitionScheduler({
    service: partitionedService([], { inspect: { partitioned: false } }),
    logger: { info() {}, error() {} },
    setIntervalFn: () => { timers += 1; return { unref() {} }; },
  });

  const first = scheduler.start();
  const second = scheduler.start();
  await Promise.all([first.initialRun, second.initialRun]);
  assert.equal(timers, 1);
  first.stop();
});
