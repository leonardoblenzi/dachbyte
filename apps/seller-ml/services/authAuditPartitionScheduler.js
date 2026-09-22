"use strict";

const DEFAULT_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MIN_MAINTENANCE_INTERVAL_MS = 60 * 1000;
let defaultScheduler = null;

function resolveMaintenanceInterval({ env = process.env } = {}) {
  const raw = String(env?.AUTH_AUDIT_PARTITION_MAINTENANCE_INTERVAL_MS ?? "").trim();
  if (!raw) return { enabled: true, intervalMs: DEFAULT_MAINTENANCE_INTERVAL_MS };
  if (["0", "false", "off", "no"].includes(raw.toLowerCase())) {
    return { enabled: false, intervalMs: 0 };
  }

  const requested = Number(raw);
  if (!Number.isFinite(requested) || requested <= 0) {
    return { enabled: true, intervalMs: DEFAULT_MAINTENANCE_INTERVAL_MS };
  }
  return { enabled: true, intervalMs: Math.max(MIN_MAINTENANCE_INTERVAL_MS, Math.floor(requested)) };
}

function defaultServiceFactory({ db, cleanupAuthAudit }) {
  const resolvedDb = db || require("../db/db");
  const resolvedCleanup = cleanupAuthAudit || require("./authAuditService").cleanupAuthAudit;
  const { createAuthAuditPartitionService } = require("./authAuditPartitionService");
  return createAuthAuditPartitionService({ db: resolvedDb, cleanupAuthAudit: resolvedCleanup });
}

function createAuthAuditPartitionScheduler({
  service,
  db,
  cleanupAuthAudit,
  createService = defaultServiceFactory,
  env = process.env,
  logger = console,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const config = resolveMaintenanceInterval({ env });
  const partitionService = service || createService({ db, cleanupAuthAudit });
  let inFlight = null;
  let timer = null;

  async function execute() {
    try {
      const parent = await partitionService.inspectCurrentTable();
      if (!parent?.partitioned) {
        logger.info?.("[AuthAuditPartition] Manutencao ignorada: ml.auth_audit ainda nao esta particionada.");
        return { skipped: true, reason: "parent_not_partitioned", parent };
      }

      const ensured = await partitionService.ensurePartitions();
      const drained = await partitionService.drainDefaultPartition();
      // pruneExpiredPartitions reutiliza cleanupAuthAudit injetado no servico e, sem
      // confirmDrop, somente identifica particoes elegiveis: nunca remove dados no startup.
      const pruned = await partitionService.pruneExpiredPartitions({ confirmDrop: false });
      const verification = await partitionService.verifyPartitionedAudit();
      logger.info?.("[AuthAuditPartition] Manutencao concluida em dry-run.");
      return {
        skipped: false,
        ensured,
        drained,
        pruned,
        verification,
      };
    } catch (error) {
      const message = error?.message || "erro desconhecido";
      logger.error?.("[AuthAuditPartition] Manutencao falhou:", message);
      return { skipped: false, failed: true, error: message };
    }
  }

  function run() {
    if (inFlight) return inFlight;
    inFlight = execute().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function stop() {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  }

  function start() {
    if (!config.enabled) {
      logger.info?.("[AuthAuditPartition] Scheduler de manutencao desativado por env.");
      return { enabled: false, intervalMs: 0, initialRun: Promise.resolve({ skipped: true, reason: "disabled" }), stop };
    }
    if (!timer) {
      timer = setIntervalFn(() => void run(), config.intervalMs);
      if (typeof timer?.unref === "function") timer.unref();
      logger.info?.("[AuthAuditPartition] Scheduler de manutencao ativo em dry-run.");
    }
    return { enabled: true, intervalMs: config.intervalMs, initialRun: run(), stop };
  }

  return { run, start, stop, config };
}

function startAuthAuditPartitionScheduler(options) {
  if (!defaultScheduler) defaultScheduler = createAuthAuditPartitionScheduler(options);
  return defaultScheduler.start();
}

module.exports = {
  DEFAULT_MAINTENANCE_INTERVAL_MS,
  MIN_MAINTENANCE_INTERVAL_MS,
  createAuthAuditPartitionScheduler,
  resolveMaintenanceInterval,
  startAuthAuditPartitionScheduler,
};
