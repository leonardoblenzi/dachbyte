"use strict";

const { randomUUID: systemRandomUUID } = require("node:crypto");

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
  randomUUID = systemRandomUUID,
} = {}) {
  const config = resolveMaintenanceInterval({ env });
  const partitionService = service || createService({ db, cleanupAuthAudit });
  let inFlight = null;
  let timer = null;

  async function execute() {
    const operationId = randomUUID();
    let operationStarted = false;
    try {
      // Sem o registro inicial nao fazemos nenhuma mutacao: se o ledger estiver
      // indisponivel, a execucao falha de forma observavel e podera ser repetida.
      await partitionService.recordOperation({
        operationId,
        kind: "maintenance",
        status: "started",
        details: { phase: "started" },
      });
      operationStarted = true;
      const parent = await partitionService.inspectCurrentTable();
      if (!parent?.partitioned) {
        await partitionService.recordOperation({
          operationId,
          kind: "maintenance",
          status: "skipped",
          details: { outcome: "skipped", reason: "parent_not_partitioned" },
        });
        logger.info?.("[AuthAuditPartition] Manutencao ignorada: ml.auth_audit ainda nao esta particionada.");
        return { skipped: true, reason: "parent_not_partitioned", parent };
      }

      const ensured = await partitionService.ensurePartitions();
      const drained = await partitionService.drainDefaultPartition();
      // pruneExpiredPartitions executa a limpeza normal pelas regras de retencao configuradas.
      // Sem confirmDrop, a etapa posterior apenas identifica particoes elegiveis: DETACH/DROP
      // de particao nunca ocorre pelo scheduler de startup.
      const pruned = await partitionService.pruneExpiredPartitions({ confirmDrop: false });
      const verification = await partitionService.verifyPartitionedAudit();
      await partitionService.recordOperation({
        operationId,
        kind: "maintenance",
        status: "completed",
        details: {
          outcome: "completed",
          moved: Number(drained?.moved || 0),
          eligiblePartitions: Array.isArray(pruned?.eligible) ? pruned.eligible.length : 0,
          defaultRows: verification?.defaultRows ?? null,
        },
      });
      logger.info?.("[AuthAuditPartition] Limpeza de retencao aplicada; remocao de particoes permanece em dry-run.");
      return {
        skipped: false,
        ensured,
        drained,
        pruned,
        verification,
      };
    } catch (error) {
      const message = error?.message || "erro desconhecido";
      let auditRecorded = false;
      if (operationStarted) {
        try {
          await partitionService.recordOperation({
            operationId,
            kind: "maintenance",
            status: "failed",
            // Nao persistimos mensagens de erro, pois podem carregar detalhes sensiveis.
            details: { outcome: "failed", reason: "maintenance_error" },
          });
          auditRecorded = true;
        } catch (ledgerError) {
          logger.error?.("[AuthAuditPartition] Falha ao registrar falha de manutencao no ledger:", ledgerError?.message || "erro desconhecido");
        }
      }
      logger.error?.("[AuthAuditPartition] Manutencao falhou:", message);
      return { skipped: false, failed: true, auditRecorded, error: message };
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
      logger.info?.("[AuthAuditPartition] Scheduler ativo: retencao configurada e aplicada; remocao de particoes em dry-run.");
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
