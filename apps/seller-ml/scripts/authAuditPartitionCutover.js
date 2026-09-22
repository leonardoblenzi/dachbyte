"use strict";

const { randomUUID: systemRandomUUID } = require("node:crypto");

const SCHEMA = "ml";
const LEGACY_TABLE = "auth_audit";
const SHADOW_TABLE = "auth_audit_partitioned_new";
const DEFAULT_PARTITION = "auth_audit_partitioned_new_default";
const MONTHLY_PARTITION = /^auth_audit_partitioned_new_(\d{4})_(\d{2})$/;
const SAFE_TABLES = new Set([LEGACY_TABLE, SHADOW_TABLE, DEFAULT_PARTITION]);
const OPERATION_KINDS = new Set(["preflight", "copy", "validate", "swap", "rollback"]);
const OPERATION_STATUSES = new Set(["started", "completed", "failed", "skipped"]);

function quoteIdentifier(name) {
  const value = String(name || "");
  const monthly = MONTHLY_PARTITION.exec(value);
  const isMonthly = monthly && Number(monthly[2]) >= 1 && Number(monthly[2]) <= 12;
  const isLegacy = /^auth_audit_legacy_[a-f0-9]{12}$/.test(value);
  const isFailed = /^auth_audit_partitioned_failed_[a-f0-9]{12}$/.test(value);
  if (!SAFE_TABLES.has(value) && !isMonthly && !isLegacy && !isFailed) {
    throw new Error("Identificador de tabela de auditoria invalido.");
  }
  return `${SCHEMA}.${value}`;
}

function monthStart(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Data de particao invalida.");
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(value, count) {
  const date = monthStart(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
}

function monthlyPartitionName(value) {
  const date = monthStart(value);
  return `auth_audit_partitioned_new_${date.getUTCFullYear()}_${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function normalizeCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeAggregate(row = {}) {
  return {
    count: String(row.count ?? "0"),
    minCreatedAt: row.min_created_at ? new Date(row.min_created_at).toISOString() : null,
    maxCreatedAt: row.max_created_at ? new Date(row.max_created_at).toISOString() : null,
  };
}

function stableRows(rows) {
  return (rows || []).map((row) => ({
    monthStart: row.month_start ? new Date(row.month_start).toISOString() : null,
    count: String(row.row_count ?? "0"),
    checksum: String(row.checksum ?? ""),
  }));
}

function parseArgs(argv) {
  const result = { command: null, dryRun: false, batchSize: undefined };
  for (const argument of argv) {
    if (!result.command && !String(argument).startsWith("--")) result.command = String(argument);
    else if (argument === "--dry-run") result.dryRun = true;
    else if (String(argument).startsWith("--batch-size=")) result.batchSize = Number(String(argument).slice(13));
  }
  return result;
}

function createAuthAuditPartitionCutover({
  db,
  clock = () => new Date(),
  randomUUID = systemRandomUUID,
  env = process.env,
  monthsAhead = 18,
  logger = console,
} = {}) {
  if (!db || typeof db.query !== "function") throw new Error("db.query e obrigatorio.");
  const futureMonths = Number.isInteger(monthsAhead) && monthsAhead >= 0 ? monthsAhead : 18;

  async function transaction(work) {
    const execute = async (client) => {
      await client.query("BEGIN");
      try {
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    };
    if (typeof db.withClient === "function") return db.withClient(execute);
    return execute(db);
  }

  async function recordOperation({ operationId = randomUUID(), kind, status, details = {} }) {
    if (!OPERATION_KINDS.has(kind)) throw new Error("Tipo de operacao invalido.");
    if (!OPERATION_STATUSES.has(status)) throw new Error("Status de operacao invalido.");
    const finalStatus = status !== "started";
    await db.query(`
      INSERT INTO ml.auth_audit_partition_operations (operation_id, kind, status, details, completed_at)
      VALUES ($1, $2, $3, $4::jsonb, $5)
      ON CONFLICT (operation_id) DO UPDATE
        SET status = EXCLUDED.status,
            details = EXCLUDED.details,
            completed_at = EXCLUDED.completed_at`, [
      operationId,
      kind,
      status,
      JSON.stringify(details),
      finalStatus ? new Date(clock()).toISOString() : null,
    ]);
    return operationId;
  }

  async function failOperation(operationId, kind, error, details = {}) {
    try {
      await recordOperation({
        operationId,
        kind,
        status: "failed",
        details: { ...details, error: String(error?.message || error) },
      });
    } catch (recordError) {
      logger.warn?.("[AuthAuditPartition] Nao foi possivel registrar falha no ledger.", recordError?.message || recordError);
    }
  }

  async function latestCompleted(kind) {
    const result = await db.query(`
      SELECT operation_id, details, completed_at
        FROM ml.auth_audit_partition_operations
       WHERE kind = $1 AND status = 'completed'
       ORDER BY completed_at DESC NULLS LAST, created_at DESC
       LIMIT 1`, [kind]);
    return result.rows?.[0] || null;
  }

  async function requirePreflight() {
    const operation = await latestCompleted("preflight");
    if (!operation) throw new Error("Preflight valido obrigatorio antes desta acao.");
    return operation;
  }

  async function inspectLegacy() {
    const result = await db.query(`
      SELECT table_class.relkind,
             pg_total_relation_size(table_class.oid)::bigint AS bytes,
             (SELECT count(*)::bigint FROM ml.auth_audit) AS row_count,
             (SELECT min(created_at) FROM ml.auth_audit) AS min_created_at,
             (SELECT max(created_at) FROM ml.auth_audit) AS max_created_at
        FROM pg_catalog.pg_class table_class
        JOIN pg_catalog.pg_namespace table_schema ON table_schema.oid = table_class.relnamespace
       WHERE table_schema.nspname = $1 AND table_class.relname = $2`, [SCHEMA, LEGACY_TABLE]);
    return result.rows?.[0] || null;
  }

  async function preflight() {
    const operationId = randomUUID();
    try {
      const [legacy, ledger, disk] = await Promise.all([
        inspectLegacy(),
        db.query("SELECT to_regclass('ml.auth_audit_partition_operations') IS NOT NULL AS exists"),
        db.query("SELECT current_setting('data_directory', true) AS data_directory"),
      ]);
      const table = legacy;
      const checklist = [
        { id: "legacy_table", ok: Boolean(table), detail: table ? `relkind=${table.relkind}` : "ml.auth_audit ausente" },
        { id: "legacy_shape", ok: table?.relkind === "r", detail: "cutover requer tabela legacy regular" },
        { id: "partition_ledger", ok: ledger.rows?.[0]?.exists === true, detail: "migration 072 deve estar aplicada" },
        { id: "free_space", ok: false, detail: "confirmar espaco livre externamente (df/console do provedor) para copia integral antes da janela" },
        { id: "backup_restore", ok: false, detail: "exigir backup Restic/R2 recente e restore testado antes do swap" },
        { id: "maintenance_window", ok: false, detail: "parar somente web/worker externamente na janela; este CLI nao para containers" },
      ];
      const result = {
        ok: checklist.slice(0, 3).every((item) => item.ok),
        checklist,
        legacy: table && {
          relkind: table.relkind,
          bytes: normalizeCount(table.bytes),
          rowCount: normalizeCount(table.row_count),
          minCreatedAt: table.min_created_at || null,
          maxCreatedAt: table.max_created_at || null,
        },
        dataDirectory: disk.rows?.[0]?.data_directory || null,
      };
      if (ledger.rows?.[0]?.exists === true) {
        await recordOperation({ operationId, kind: "preflight", status: result.ok ? "completed" : "failed", details: result });
      }
      if (!result.ok) throw new Error("Preflight invalido: confira tabela legacy e migration 072.");
      return result;
    } catch (error) {
      await failOperation(operationId, "preflight", error);
      throw error;
    }
  }

  async function createShadow(executor) {
    await executor.query(`
      CREATE TABLE IF NOT EXISTS ml.${SHADOW_TABLE} (
        id bigint NOT NULL DEFAULT nextval('ml.auth_audit_id_seq'::regclass),
        user_id bigint REFERENCES ml.usuarios(id) ON DELETE SET NULL,
        email text,
        evento text NOT NULL,
        status text NOT NULL DEFAULT 'info',
        ip text,
        user_agent text,
        metadata jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        empresa_id bigint REFERENCES ml.empresas(id) ON DELETE CASCADE,
        meli_conta_id bigint REFERENCES ml.meli_contas(id) ON DELETE CASCADE,
        CONSTRAINT auth_audit_partitioned_new_pkey PRIMARY KEY (created_at, id)
      ) PARTITION BY RANGE (created_at)`);
    await executor.query(`CREATE INDEX IF NOT EXISTS auth_audit_partitioned_new_created_at_idx ON ml.${SHADOW_TABLE} (created_at)`);
    await executor.query(`CREATE INDEX IF NOT EXISTS auth_audit_partitioned_new_user_id_idx ON ml.${SHADOW_TABLE} (user_id)`);
    await executor.query(`CREATE INDEX IF NOT EXISTS auth_audit_partitioned_new_evento_idx ON ml.${SHADOW_TABLE} (evento)`);
    await executor.query(`CREATE INDEX IF NOT EXISTS auth_audit_partitioned_new_empresa_created_at_idx ON ml.${SHADOW_TABLE} (empresa_id, created_at DESC)`);
    await executor.query(`CREATE INDEX IF NOT EXISTS auth_audit_partitioned_new_meli_conta_created_at_idx ON ml.${SHADOW_TABLE} (meli_conta_id, created_at DESC)`);
  }

  async function ensureShadowPartitions(executor, earliest) {
    const start = monthStart(earliest || clock());
    const end = addMonths(clock(), futureMonths);
    for (let month = start; month <= end; month = addMonths(month, 1)) {
      const name = monthlyPartitionName(month);
      const next = addMonths(month, 1);
      await executor.query(`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(name)} PARTITION OF ml.${SHADOW_TABLE}
        FOR VALUES FROM ('${month.toISOString()}') TO ('${next.toISOString()}')`);
    }
    await executor.query(`CREATE TABLE IF NOT EXISTS ml.${DEFAULT_PARTITION} PARTITION OF ml.${SHADOW_TABLE} DEFAULT`);
  }

  async function copy({ batchSize = 10000, dryRun = false } = {}) {
    await requirePreflight();
    const earliestResult = await db.query("SELECT min(created_at) AS min_created_at FROM ml.auth_audit");
    const earliest = earliestResult.rows?.[0]?.min_created_at;
    if (dryRun) return { dryRun: true, earliest: earliest || null, copied: 0 };
    const operationId = randomUUID();
    const safeBatchSize = Math.max(1, Math.min(100000, Number(batchSize) || 10000));
    try {
      await recordOperation({ operationId, kind: "copy", status: "started", details: { batchSize: safeBatchSize, earliest: earliest || null } });
      await createShadow(db);
      await ensureShadowPartitions(db, earliest || clock());
      let lastId = 0;
      let copied = 0;
      for (;;) {
        const result = await db.query(`
          WITH source AS (
            SELECT id, user_id, email, evento, status, ip, user_agent, metadata, created_at, empresa_id, meli_conta_id
              FROM ml.auth_audit
             WHERE id > $1
             ORDER BY id
             LIMIT $2
          ), inserted AS (
            INSERT INTO ml.${SHADOW_TABLE} (id, user_id, email, evento, status, ip, user_agent, metadata, created_at, empresa_id, meli_conta_id)
            SELECT id, user_id, email, evento, status, ip, user_agent, metadata, created_at, empresa_id, meli_conta_id
              FROM source
            ON CONFLICT (created_at, id) DO NOTHING
            RETURNING id
          )
          SELECT (SELECT count(*)::bigint FROM inserted) AS copied,
                 (SELECT max(id)::bigint FROM source) AS last_id` , [lastId, safeBatchSize]);
        const row = result.rows?.[0] || {};
        copied += normalizeCount(row.copied);
        if (row.last_id === null || row.last_id === undefined) break;
        lastId = normalizeCount(row.last_id);
        await recordOperation({ operationId, kind: "copy", status: "started", details: { batchSize: safeBatchSize, copied, lastId } });
      }
      const outcome = { copied, lastId, batchSize: safeBatchSize };
      await recordOperation({ operationId, kind: "copy", status: "completed", details: outcome });
      return outcome;
    } catch (error) {
      await failOperation(operationId, "copy", error, { batchSize: safeBatchSize });
      throw error;
    }
  }

  async function verify() {
    const operationId = randomUUID();
    try {
      const [legacy, shadow, legacyMonths, shadowMonths, shape] = await Promise.all([
        db.query("SELECT count(*)::bigint AS count, min(created_at) AS min_created_at, max(created_at) AS max_created_at FROM ml.auth_audit"),
        db.query(`SELECT count(*)::bigint AS count, min(created_at) AS min_created_at, max(created_at) AS max_created_at FROM ml.${SHADOW_TABLE}`),
        db.query("SELECT date_trunc('month', created_at AT TIME ZONE 'UTC') AS month_start, count(*)::bigint AS row_count, COALESCE(sum(hashtextextended(concat_ws('|', id, created_at, evento, status), 0)::numeric), 0)::text AS checksum FROM ml.auth_audit GROUP BY 1 ORDER BY 1"),
        db.query(`SELECT date_trunc('month', created_at AT TIME ZONE 'UTC') AS month_start, count(*)::bigint AS row_count, COALESCE(sum(hashtextextended(concat_ws('|', id, created_at, evento, status), 0)::numeric), 0)::text AS checksum FROM ml.${SHADOW_TABLE} GROUP BY 1 ORDER BY 1`),
        db.query(`SELECT parent.relkind, pg_get_partkeydef(parent.oid) AS partkey,
          (SELECT string_agg(attribute.attname, ', ' ORDER BY key.ordinality)
             FROM pg_constraint constraint_row
             JOIN unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, ordinality) ON true
             JOIN pg_attribute attribute ON attribute.attrelid = parent.oid AND attribute.attnum = key.attnum
            WHERE constraint_row.conrelid = parent.oid AND constraint_row.contype = 'p') AS primary_key,
          (SELECT count(*)::bigint FROM pg_inherits inheritance WHERE inheritance.inhparent = parent.oid) AS partitions
          FROM pg_class parent JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
         WHERE namespace.nspname = $1 AND parent.relname = $2`, [SCHEMA, SHADOW_TABLE]),
      ]);
      const mismatches = [];
      if (JSON.stringify(normalizeAggregate(legacy.rows?.[0])) !== JSON.stringify(normalizeAggregate(shadow.rows?.[0]))) mismatches.push("aggregate");
      if (JSON.stringify(stableRows(legacyMonths.rows)) !== JSON.stringify(stableRows(shadowMonths.rows))) mismatches.push("monthly_checksum");
      const schema = shape.rows?.[0] || {};
      if (schema.relkind !== "p" || !/created_at/i.test(String(schema.partkey)) || !/created_at\s*,\s*id/i.test(String(schema.primary_key)) || normalizeCount(schema.partitions) < 2) mismatches.push("partition_shape");
      const outcome = { ok: mismatches.length === 0, mismatches, legacy: normalizeAggregate(legacy.rows?.[0]), shadow: normalizeAggregate(shadow.rows?.[0]) };
      await recordOperation({ operationId, kind: "validate", status: outcome.ok ? "completed" : "failed", details: outcome });
      if (!outcome.ok) throw new Error(`Verificacao encontrou divergencia: ${mismatches.join(", ")}.`);
      return outcome;
    } catch (error) {
      await failOperation(operationId, "validate", error);
      throw error;
    }
  }

  function requireConfirmation(expected) {
    if (env.AUTH_AUDIT_PARTITION_CONFIRM !== expected) {
      throw new Error(`Defina AUTH_AUDIT_PARTITION_CONFIRM=${expected} para executar esta operacao.`);
    }
  }

  async function swap({ dryRun = false } = {}) {
    requireConfirmation("SWAP");
    await requirePreflight();
    if (!dryRun && !await latestCompleted("validate")) throw new Error("Verify valido obrigatorio antes do swap.");
    if (dryRun) return { dryRun: true, action: "swap" };
    const operationId = randomUUID();
    const suffix = operationId.replace(/-/g, "").slice(0, 12).toLowerCase();
    const legacyName = `auth_audit_legacy_${suffix}`;
    try {
      await recordOperation({ operationId, kind: "swap", status: "started", details: { legacyName } });
      await transaction(async (client) => {
        await client.query(`LOCK TABLE ml.${LEGACY_TABLE}, ml.${SHADOW_TABLE} IN ACCESS EXCLUSIVE MODE`);
        await client.query(`ALTER TABLE ml.${LEGACY_TABLE} RENAME TO ${legacyName}`);
        await client.query(`ALTER TABLE ml.${SHADOW_TABLE} RENAME TO ${LEGACY_TABLE}`);
        await client.query(`ALTER SEQUENCE ml.auth_audit_id_seq OWNED BY ml.${LEGACY_TABLE}.id`);
      });
      const outcome = { legacyName };
      await recordOperation({ operationId, kind: "swap", status: "completed", details: outcome });
      return outcome;
    } catch (error) {
      await failOperation(operationId, "swap", error, { legacyName });
      throw error;
    }
  }

  async function rollback({ dryRun = false, legacyName } = {}) {
    requireConfirmation("ROLLBACK");
    await requirePreflight();
    let resolvedLegacy = legacyName;
    if (!resolvedLegacy) {
      const latest = await db.query(`
        SELECT relname
          FROM pg_catalog.pg_class relation
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = $1
           AND relation.relname ~ '^auth_audit_legacy_[a-f0-9]{12}$'
         ORDER BY relation.relname DESC
         LIMIT 1`, [SCHEMA]);
      resolvedLegacy = latest.rows?.[0]?.relname;
    }
    if (!/^auth_audit_legacy_[a-f0-9]{12}$/.test(String(resolvedLegacy || ""))) throw new Error("Nome de legacy para rollback invalido.");
    const legacy = quoteIdentifier(resolvedLegacy);
    if (dryRun) return { dryRun: true, action: "rollback", legacyName: resolvedLegacy };
    const exists = await db.query("SELECT to_regclass($1) IS NOT NULL AS exists", [`ml.${resolvedLegacy}`]);
    if (exists.rows?.[0]?.exists !== true) throw new Error("Rollback indisponivel: tabela legacy nao existe.");
    const operationId = randomUUID();
    const suffix = operationId.replace(/-/g, "").slice(0, 12).toLowerCase();
    const failedName = `auth_audit_partitioned_failed_${suffix}`;
    try {
      await recordOperation({ operationId, kind: "rollback", status: "started", details: { legacyName: resolvedLegacy, failedName } });
      await transaction(async (client) => {
        await client.query(`LOCK TABLE ml.${LEGACY_TABLE}, ${legacy} IN ACCESS EXCLUSIVE MODE`);
        await client.query(`ALTER TABLE ml.${LEGACY_TABLE} RENAME TO ${failedName}`);
        await client.query(`ALTER TABLE ${legacy} RENAME TO ${LEGACY_TABLE}`);
        await client.query(`ALTER SEQUENCE ml.auth_audit_id_seq OWNED BY ml.${LEGACY_TABLE}.id`);
      });
      const outcome = { legacyName: resolvedLegacy, failedName };
      await recordOperation({ operationId, kind: "rollback", status: "completed", details: outcome });
      return outcome;
    } catch (error) {
      await failOperation(operationId, "rollback", error, { legacyName: resolvedLegacy, failedName });
      throw error;
    }
  }

  async function status() {
    const [legacy, shadow, operations] = await Promise.all([
      inspectLegacy(),
      db.query(`SELECT relation.relkind, pg_get_partkeydef(relation.oid) AS partition_key
        FROM pg_catalog.pg_class relation
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = $1 AND relation.relname = $2`, [SCHEMA, SHADOW_TABLE]),
      db.query("SELECT operation_id, kind, status, details, started_at, completed_at FROM ml.auth_audit_partition_operations ORDER BY created_at DESC LIMIT 20"),
    ]);
    return { legacy, shadow: shadow.rows?.[0] || null, operations: operations.rows || [] };
  }

  return { status, preflight, copy, verify, swap, rollback, recordOperation };
}

async function main() {
  const { command, dryRun, batchSize } = parseArgs(process.argv.slice(2));
  if (!new Set(["status", "preflight", "copy", "verify", "swap", "rollback"]).has(command)) {
    throw new Error("Uso: node scripts/authAuditPartitionCutover.js <status|preflight|copy|verify|swap|rollback> [--dry-run] [--batch-size=10000]");
  }
  const db = require("../db/db");
  const cutover = createAuthAuditPartitionCutover({ db });
  const result = await cutover[command]({ dryRun, batchSize });
  loggerOutput(result);
}

function loggerOutput(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((error) => {
    console.error("[AuthAuditPartition] Cutover falhou:", error?.message || error);
    process.exit(1);
  });
}

module.exports = {
  createAuthAuditPartitionCutover,
  quoteIdentifier,
  monthlyPartitionName,
  parseArgs,
};
