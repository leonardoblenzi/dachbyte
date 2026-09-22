"use strict";

const { randomUUID: systemRandomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const { AsyncLocalStorage } = require("node:async_hooks");

const SCHEMA = "ml";
const LEGACY_TABLE = "auth_audit";
const SHADOW_TABLE = "auth_audit_partitioned_new";
const DEFAULT_PARTITION = "auth_audit_partitioned_new_default";
const MONTHLY_PARTITION = /^auth_audit_partitioned_new_(\d{4})_(\d{2})$/;
const LIVE_DEFAULT_PARTITION = "auth_audit_default";
const LIVE_MONTHLY_PARTITION = /^auth_audit_(\d{4})_(\d{2})$/;
const SAFE_TABLES = new Set([LEGACY_TABLE, SHADOW_TABLE, DEFAULT_PARTITION, LIVE_DEFAULT_PARTITION]);
const ADVISORY_LOCK_KEY = "ml.auth_audit_partition_cutover_v1";
const OPERATION_KINDS = new Set(["preflight", "copy", "validate", "swap", "rollback"]);
const OPERATION_STATUSES = new Set(["started", "completed", "failed", "skipped"]);

function quoteIdentifier(name) {
  const value = String(name || "");
  const monthly = MONTHLY_PARTITION.exec(value);
  const isMonthly = monthly && Number(monthly[2]) >= 1 && Number(monthly[2]) <= 12;
  const liveMonthly = LIVE_MONTHLY_PARTITION.exec(value);
  const isLiveMonthly = liveMonthly && Number(liveMonthly[2]) >= 1 && Number(liveMonthly[2]) <= 12;
  const isLegacy = /^auth_audit_legacy_[a-f0-9]{12}$/.test(value);
  const isFailed = /^auth_audit_partitioned_failed_[a-f0-9]{12}$/.test(value);
  const isFailedChild = /^auth_audit_partitioned_failed_[a-f0-9]{12}_(?:\d{4}_\d{2}|default)$/.test(value);
  if (!SAFE_TABLES.has(value) && !isMonthly && !isLiveMonthly && !isLegacy && !isFailed && !isFailedChild) {
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
    minId: row.min_id === null || row.min_id === undefined ? null : String(row.min_id),
    maxId: row.max_id === null || row.max_id === undefined ? null : String(row.max_id),
    minCreatedAt: row.min_created_at ? new Date(row.min_created_at).toISOString() : null,
    maxCreatedAt: row.max_created_at ? new Date(row.max_created_at).toISOString() : null,
  };
}

function normalizeMarker(row = {}) {
  return {
    rowCount: normalizeCount(row.row_count),
    maxId: row.max_id === null || row.max_id === undefined ? null : String(row.max_id),
    maxCreatedAt: row.max_created_at ? new Date(row.max_created_at).toISOString() : null,
  };
}

function operationApprovalFromEnv(env) {
  return {
    backupRestored: env.AUTH_AUDIT_PARTITION_BACKUP_RESTORED === "YES",
    maintenanceWindow: env.AUTH_AUDIT_PARTITION_MAINTENANCE_WINDOW === "YES",
    capacityConfirmed: env.AUTH_AUDIT_PARTITION_CAPACITY_CONFIRMED === "YES",
    availableBytes: normalizeCount(env.AUTH_AUDIT_PARTITION_AVAILABLE_BYTES),
  };
}

async function defaultDiskInspector(env) {
  const diskPath = String(env.AUTH_AUDIT_PARTITION_DISK_PATH || "").trim();
  if (!diskPath) return { availableBytes: null, source: "unavailable" };
  try {
    const stats = await fs.statfs(diskPath);
    return {
      availableBytes: Number(stats.bavail) * Number(stats.bsize),
      source: "node_statfs",
      path: diskPath,
    };
  } catch (error) {
    return { availableBytes: null, source: "statfs_error", error: String(error?.message || error) };
  }
}

function stableRows(rows) {
  return (rows || []).map((row) => ({
    monthStart: row.month_start ? new Date(row.month_start).toISOString() : null,
    evento: String(row.evento ?? ""),
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
  diskInspector = () => defaultDiskInspector(env),
} = {}) {
  if (!db || typeof db.query !== "function") throw new Error("db.query e obrigatorio.");
  const futureMonths = Number.isInteger(monthsAhead) && monthsAhead >= 0 ? monthsAhead : 18;
  // A pool-level query is not enough for pg_advisory_lock: subsequent queries
  // could be sent to another connection.  Keep a client in async-local state so
  // every query for a command runs on the connection that owns its session lock.
  const sessionStorage = new AsyncLocalStorage();
  const query = (sql, params) => (sessionStorage.getStore() || db).query(sql, params);

  async function withSessionAdvisoryLock(work) {
    if (typeof db.withClient !== "function") throw new Error("db.withClient e obrigatorio para serializar o cutover.");
    return db.withClient(async (client) => {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [ADVISORY_LOCK_KEY]);
      try {
        return await sessionStorage.run(client, work);
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [ADVISORY_LOCK_KEY]);
      }
    });
  }

  async function transaction(work) {
    const execute = async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [ADVISORY_LOCK_KEY]);
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    };
    const lockedClient = sessionStorage.getStore();
    if (lockedClient) return execute(lockedClient);
    if (typeof db.withClient === "function") return db.withClient(execute);
    return execute(db);
  }

  async function recordOperation({ operationId = randomUUID(), kind, status, details = {} }) {
    if (!OPERATION_KINDS.has(kind)) throw new Error("Tipo de operacao invalido.");
    if (!OPERATION_STATUSES.has(status)) throw new Error("Status de operacao invalido.");
    const finalStatus = status !== "started";
    await query(`
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
    const result = await query(`
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
    if (operation.details?.operationalApproval?.approved !== true) {
      throw new Error("Preflight sem aprovacao operacional: backup/restore, janela e capacidade devem estar confirmados.");
    }
    return operation;
  }

  async function inspectLegacy() {
    const result = await query(`
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

  async function inspectShape(tableName) {
    const result = await query(`
      SELECT attribute.attname,
             attribute.atttypid::regtype::text AS data_type,
             attribute.attnotnull,
             pg_get_expr(default_value.adbin, default_value.adrelid) AS default_expression
        FROM pg_catalog.pg_attribute attribute
        JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        LEFT JOIN pg_catalog.pg_attrdef default_value
          ON default_value.adrelid = attribute.attrelid AND default_value.adnum = attribute.attnum
       WHERE namespace.nspname = $1 AND relation.relname = $2
         AND attribute.attnum > 0 AND NOT attribute.attisdropped
       ORDER BY attribute.attnum`, [SCHEMA, tableName]);
    return result.rows || [];
  }

  async function inspectForeignKeys(tableName) {
    const result = await query(`
      SELECT constraint_row.conname,
             target_namespace.nspname AS target_schema,
             target_relation.relname AS target_table,
             constraint_row.confdeltype AS delete_type
        FROM pg_catalog.pg_constraint constraint_row
        JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        LEFT JOIN pg_catalog.pg_class target_relation ON target_relation.oid = constraint_row.confrelid
        LEFT JOIN pg_catalog.pg_namespace target_namespace ON target_namespace.oid = target_relation.relnamespace
       WHERE namespace.nspname = $1 AND relation.relname = $2 AND constraint_row.contype = 'f'
       ORDER BY constraint_row.conname`, [SCHEMA, tableName]);
    return result.rows || [];
  }

  async function inspectIncomingForeignKeys() {
    const result = await query(`
      SELECT constraint_row.conname, source_namespace.nspname AS source_schema, source_relation.relname AS source_table
        FROM pg_catalog.pg_constraint constraint_row
        JOIN pg_catalog.pg_class source_relation ON source_relation.oid = constraint_row.conrelid
        JOIN pg_catalog.pg_namespace source_namespace ON source_namespace.oid = source_relation.relnamespace
       WHERE constraint_row.confrelid = 'ml.auth_audit'::regclass AND constraint_row.contype = 'f'
       ORDER BY constraint_row.conname`);
    return result.rows || [];
  }

  async function inspectGrants(tableName, executor = sessionStorage.getStore() || db) {
    const result = await executor.query(`
      SELECT grantee, privilege_type
        FROM information_schema.role_table_grants
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY grantee, privilege_type`, [SCHEMA, tableName]);
    return result.rows || [];
  }

  function quoteRole(role) {
    const value = String(role || "");
    if (value === "PUBLIC") return "PUBLIC";
    if (!value || /[\u0000-\u001F]/.test(value)) throw new Error("Role de grant invalida.");
    return `"${value.replaceAll('"', '""')}"`;
  }

  async function copyLegacyGrants(executor, grants) {
    const supported = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]);
    for (const grant of grants) {
      const privilege = String(grant.privilege_type || "").toUpperCase();
      if (!supported.has(privilege)) throw new Error("Privilegio de grant invalido.");
      await executor.query(`GRANT ${privilege} ON TABLE ml.${SHADOW_TABLE} TO ${quoteRole(grant.grantee)}`);
    }
  }

  function grantsAreSupported(grants) {
    const supported = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]);
    return grants.every((grant) => supported.has(String(grant.privilege_type || "").toUpperCase()) && String(grant.grantee || "").trim());
  }

  function grantsMatch(left, right) {
    const normalize = (grants) => grants.map((grant) => `${grant.grantee}:${String(grant.privilege_type || "").toUpperCase()}`).sort();
    return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
  }

  function hasExpectedShape(columns, foreignKeys) {
    const expected = new Map([
      ["id", { type: "bigint", required: true, default: /nextval/i }],
      ["user_id", { type: "bigint" }], ["email", { type: "text" }],
      ["evento", { type: "text", required: true }], ["status", { type: "text", required: true, default: /info/i }],
      ["ip", { type: "text" }], ["user_agent", { type: "text" }], ["metadata", { type: "jsonb" }],
      ["created_at", { type: "timestamp with time zone", required: true, default: /now\(\)/i }],
      ["empresa_id", { type: "bigint" }], ["meli_conta_id", { type: "bigint" }],
    ]);
    const byName = new Map(columns.map((column) => [column.attname, column]));
    for (const [name, shape] of expected) {
      const column = byName.get(name);
      if (!column || column.data_type !== shape.type) return false;
      if (shape.required && column.attnotnull !== true) return false;
      if (shape.default && !shape.default.test(String(column.default_expression || ""))) return false;
    }
    const targets = new Map(foreignKeys.map((key) => [key.target_table, key.delete_type]));
    return targets.get("usuarios") === "n" && targets.get("empresas") === "c" && targets.get("meli_contas") === "c";
  }

  async function preflightUnlocked({ operationalApproval = operationApprovalFromEnv(env) } = {}) {
    const operationId = randomUUID();
    try {
      const [legacy, ledger, disk, diskProbe, columns, foreignKeys, incomingForeignKeys, grants] = await Promise.all([
        inspectLegacy(),
        query("SELECT to_regclass('ml.auth_audit_partition_operations') IS NOT NULL AS exists"),
        query("SELECT current_setting('data_directory', true) AS data_directory"),
        diskInspector(),
        inspectShape(LEGACY_TABLE),
        inspectForeignKeys(LEGACY_TABLE),
        inspectIncomingForeignKeys(),
        inspectGrants(LEGACY_TABLE),
      ]);
      const table = legacy;
      const requiredBytes = Math.ceil(normalizeCount(table?.bytes) * 1.3);
      const measuredBytes = normalizeCount(diskProbe?.availableBytes);
      const overrideBytes = normalizeCount(operationalApproval.availableBytes);
      const capacityMeasured = measuredBytes || overrideBytes;
      const capacityEnough = capacityMeasured > 0 ? capacityMeasured >= requiredBytes : null;
      const operational = {
        backupRestored: operationalApproval.backupRestored === true,
        maintenanceWindow: operationalApproval.maintenanceWindow === true,
        capacityConfirmed: operationalApproval.capacityConfirmed === true,
        availableBytes: capacityMeasured || null,
        capacitySource: measuredBytes ? diskProbe.source : (overrideBytes ? "explicit_override" : "unavailable"),
        requiredBytes,
        capacityEnough,
      };
      operational.approved = operational.backupRestored
        && operational.maintenanceWindow
        && operational.capacityConfirmed
        && capacityEnough === true;
      const checklist = [
        { id: "legacy_table", ok: Boolean(table), detail: table ? `relkind=${table.relkind}` : "ml.auth_audit ausente" },
        { id: "legacy_shape", ok: table?.relkind === "r", detail: "cutover requer tabela legacy regular" },
        { id: "partition_ledger", ok: ledger.rows?.[0]?.exists === true, detail: "migration 072 deve estar aplicada" },
        { id: "column_shape", ok: hasExpectedShape(columns, foreignKeys), detail: "colunas/defaults e FKs de saida devem corresponder ao audit atual" },
        { id: "incoming_foreign_keys", ok: incomingForeignKeys.length === 0, detail: incomingForeignKeys.length ? "existem FKs que apontam para auth_audit; tratar antes do cutover" : "nenhuma FK aponta para auth_audit" },
        { id: "grants", ok: true, detail: `${grants.length} grant(s) explicito(s) serao copiados para a shadow` },
        { id: "free_space", ok: operational.capacityConfirmed && capacityEnough === true, detail: "exige bytes livres medidos (statfs) ou override explicito validado contra estimativa com margem" },
        { id: "backup_restore", ok: operational.backupRestored, detail: "backup Restic/R2 recente e restore testado devem ser afirmados na operacao" },
        { id: "maintenance_window", ok: operational.maintenanceWindow, detail: "janela com web/worker parados externamente deve ser afirmada na operacao" },
      ];
      const result = {
        ok: checklist.every((item) => item.ok),
        checklist,
        legacy: table && {
          relkind: table.relkind,
          bytes: normalizeCount(table.bytes),
          rowCount: normalizeCount(table.row_count),
          minCreatedAt: table.min_created_at || null,
          maxCreatedAt: table.max_created_at || null,
        },
        dataDirectory: disk.rows?.[0]?.data_directory || null,
        diskProbe: diskProbe || { availableBytes: null, source: "unavailable" },
        operationalApproval: operational,
        incomingForeignKeys,
        legacyGrants: grants,
      };
      if (ledger.rows?.[0]?.exists === true) {
        await recordOperation({ operationId, kind: "preflight", status: result.ok ? "completed" : "failed", details: result });
      }
      if (!result.ok) throw new Error("Preflight invalido: confira schema, FKs, capacidade, backup/restore e janela de manutencao.");
      return result;
    } catch (error) {
      await failOperation(operationId, "preflight", error);
      throw error;
    }
  }

  async function preflight(options) {
    return withSessionAdvisoryLock(() => preflightUnlocked(options));
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

  function livePartitionNameFromShadow(name) {
    if (name === DEFAULT_PARTITION) return LIVE_DEFAULT_PARTITION;
    const match = MONTHLY_PARTITION.exec(String(name || ""));
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) throw new Error("Filho inesperado na shadow de auditoria.");
    return `auth_audit_${match[1]}_${match[2]}`;
  }

  async function renameShadowChildrenForLiveParent(executor) {
    const result = await executor.query(`
      SELECT child.relname
        FROM pg_catalog.pg_inherits inheritance
        JOIN pg_catalog.pg_class parent ON parent.oid = inheritance.inhparent
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = parent.relnamespace
        JOIN pg_catalog.pg_class child ON child.oid = inheritance.inhrelid
       WHERE namespace.nspname = $1 AND parent.relname = $2
       ORDER BY child.relname`, [SCHEMA, SHADOW_TABLE]);
    const renamed = [];
    for (const row of result.rows || []) {
      const from = String(row.relname || "");
      const to = livePartitionNameFromShadow(from);
      await executor.query(`ALTER TABLE ${quoteIdentifier(from)} RENAME TO ${to}`);
      renamed.push(to);
    }
    if (!renamed.includes(LIVE_DEFAULT_PARTITION)) throw new Error("Shadow sem particao default para o parent ativo.");
    return renamed;
  }

  function failedChildName(failedParentName, liveChildName) {
    const monthly = LIVE_MONTHLY_PARTITION.exec(String(liveChildName || ""));
    if (monthly && Number(monthly[2]) >= 1 && Number(monthly[2]) <= 12) return `${failedParentName}_${monthly[1]}_${monthly[2]}`;
    if (liveChildName === LIVE_DEFAULT_PARTITION) return `${failedParentName}_default`;
    throw new Error("Filho inesperado no parent ativo de auditoria.");
  }

  async function archiveLiveChildrenAfterRollback(executor, failedParentName) {
    const result = await executor.query(`
      SELECT child.relname
        FROM pg_catalog.pg_inherits inheritance
        JOIN pg_catalog.pg_class parent ON parent.oid = inheritance.inhparent
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = parent.relnamespace
        JOIN pg_catalog.pg_class child ON child.oid = inheritance.inhrelid
       WHERE namespace.nspname = $1 AND parent.relname = $2
       ORDER BY child.relname`, [SCHEMA, failedParentName]);
    const archived = [];
    for (const row of result.rows || []) {
      const from = String(row.relname || "");
      const to = failedChildName(failedParentName, from);
      await executor.query(`ALTER TABLE ${quoteIdentifier(from)} RENAME TO ${to}`);
      archived.push(to);
    }
    return archived;
  }

  async function copyUnlocked({ batchSize = 10000, dryRun = false } = {}) {
    await requirePreflight();
    const earliestResult = await query("SELECT min(created_at) AS min_created_at FROM ml.auth_audit");
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
        const result = await query(`
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

  async function copy(options) {
    return withSessionAdvisoryLock(() => copyUnlocked(options));
  }

  async function verifyUnlocked() {
    const operationId = randomUUID();
    try {
      const [legacy, shadow, legacyMonths, shadowMonths, associationCounts, shape, shadowColumns, shadowForeignKeys, defaultPartition, legacyGrants] = await Promise.all([
        query("SELECT count(*)::bigint AS count, min(id)::bigint AS min_id, max(id)::bigint AS max_id, min(created_at) AS min_created_at, max(created_at) AS max_created_at FROM ml.auth_audit"),
        query(`SELECT count(*)::bigint AS count, min(id)::bigint AS min_id, max(id)::bigint AS max_id, min(created_at) AS min_created_at, max(created_at) AS max_created_at FROM ml.${SHADOW_TABLE}`),
        query("SELECT date_trunc('month', created_at AT TIME ZONE 'UTC') AS month_start, evento, count(*)::bigint AS row_count, COALESCE(sum(hashtextextended(concat_ws('|', id, created_at, evento, status), 0)::numeric), 0)::text AS checksum FROM ml.auth_audit GROUP BY 1, 2 ORDER BY 1, 2"),
        query(`SELECT date_trunc('month', created_at AT TIME ZONE 'UTC') AS month_start, evento, count(*)::bigint AS row_count, COALESCE(sum(hashtextextended(concat_ws('|', id, created_at, evento, status), 0)::numeric), 0)::text AS checksum FROM ml.${SHADOW_TABLE} GROUP BY 1, 2 ORDER BY 1, 2`),
        query(`SELECT
          (SELECT count(*)::bigint FROM ml.${LEGACY_TABLE} WHERE empresa_id IS NOT NULL) AS legacy_empresa_count,
          (SELECT count(*)::bigint FROM ml.${SHADOW_TABLE} WHERE empresa_id IS NOT NULL) AS shadow_empresa_count,
          (SELECT count(*)::bigint FROM ml.${LEGACY_TABLE} WHERE meli_conta_id IS NOT NULL) AS legacy_meli_conta_count,
          (SELECT count(*)::bigint FROM ml.${SHADOW_TABLE} WHERE meli_conta_id IS NOT NULL) AS shadow_meli_conta_count`),
        query(`SELECT parent.relkind, pg_get_partkeydef(parent.oid) AS partkey,
          (SELECT string_agg(attribute.attname, ', ' ORDER BY key.ordinality)
             FROM pg_constraint constraint_row
             JOIN unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, ordinality) ON true
             JOIN pg_attribute attribute ON attribute.attrelid = parent.oid AND attribute.attnum = key.attnum
            WHERE constraint_row.conrelid = parent.oid AND constraint_row.contype = 'p') AS primary_key,
          (SELECT count(*)::bigint FROM pg_inherits inheritance WHERE inheritance.inhparent = parent.oid) AS partitions
         FROM pg_class parent JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
         WHERE namespace.nspname = $1 AND parent.relname = $2`, [SCHEMA, SHADOW_TABLE]),
        inspectShape(SHADOW_TABLE),
        inspectForeignKeys(SHADOW_TABLE),
        query(`SELECT child.relname, pg_get_expr(child.relpartbound, child.oid) AS bound,
                 (SELECT count(*)::bigint FROM ml.${DEFAULT_PARTITION}) AS row_count
            FROM pg_catalog.pg_inherits inheritance
            JOIN pg_catalog.pg_class parent ON parent.oid = inheritance.inhparent
            JOIN pg_catalog.pg_namespace namespace ON namespace.oid = parent.relnamespace
            JOIN pg_catalog.pg_class child ON child.oid = inheritance.inhrelid
           WHERE namespace.nspname = $1 AND parent.relname = $2 AND child.relname = $3`, [SCHEMA, SHADOW_TABLE, DEFAULT_PARTITION]),
        inspectGrants(LEGACY_TABLE),
      ]);
      const mismatches = [];
      if (JSON.stringify(normalizeAggregate(legacy.rows?.[0])) !== JSON.stringify(normalizeAggregate(shadow.rows?.[0]))) mismatches.push("aggregate");
      if (JSON.stringify(stableRows(legacyMonths.rows)) !== JSON.stringify(stableRows(shadowMonths.rows))) mismatches.push("monthly_checksum");
      const associations = associationCounts.rows?.[0] || {};
      if (String(associations.legacy_empresa_count ?? "0") !== String(associations.shadow_empresa_count ?? "0")) mismatches.push("empresa_id_count");
      if (String(associations.legacy_meli_conta_count ?? "0") !== String(associations.shadow_meli_conta_count ?? "0")) mismatches.push("meli_conta_id_count");
      const schema = shape.rows?.[0] || {};
      if (schema.relkind !== "p" || !/created_at/i.test(String(schema.partkey)) || !/created_at\s*,\s*id/i.test(String(schema.primary_key)) || normalizeCount(schema.partitions) < 2) mismatches.push("partition_shape");
      if (!hasExpectedShape(shadowColumns, shadowForeignKeys)) mismatches.push("column_or_foreign_key_shape");
      const defaultRow = defaultPartition.rows?.[0] || {};
      if (defaultRow.relname !== DEFAULT_PARTITION || !/DEFAULT/i.test(String(defaultRow.bound || "")) || normalizeCount(defaultRow.row_count) !== 0) mismatches.push("default_partition");
      if (!grantsAreSupported(legacyGrants)) mismatches.push("legacy_grants");
      const outcome = { ok: mismatches.length === 0, mismatches, legacy: normalizeAggregate(legacy.rows?.[0]), shadow: normalizeAggregate(shadow.rows?.[0]) };
      await recordOperation({ operationId, kind: "validate", status: outcome.ok ? "completed" : "failed", details: outcome });
      if (!outcome.ok) throw new Error(`Verificacao encontrou divergencia: ${mismatches.join(", ")}.`);
      return outcome;
    } catch (error) {
      await failOperation(operationId, "validate", error);
      throw error;
    }
  }

  async function verify() {
    return withSessionAdvisoryLock(() => verifyUnlocked());
  }

  function requireConfirmation(expected) {
    if (env.AUTH_AUDIT_PARTITION_CONFIRM !== expected) {
      throw new Error(`Defina AUTH_AUDIT_PARTITION_CONFIRM=${expected} para executar esta operacao.`);
    }
  }

  async function swapUnlocked({ dryRun = false } = {}) {
    requireConfirmation("SWAP");
    await requirePreflight();
    if (!dryRun && !await latestCompleted("validate")) throw new Error("Verify valido obrigatorio antes do swap.");
    if (dryRun) return { dryRun: true, action: "swap" };
    const operationId = randomUUID();
    const suffix = operationId.replace(/-/g, "").slice(0, 12).toLowerCase();
    const legacyName = `auth_audit_legacy_${suffix}`;
    try {
      await recordOperation({ operationId, kind: "swap", status: "started", details: { legacyName } });
      const legacyGrants = await inspectGrants(LEGACY_TABLE);
      const marker = await transaction(async (client) => {
        await client.query(`LOCK TABLE ml.${LEGACY_TABLE}, ml.${SHADOW_TABLE} IN ACCESS EXCLUSIVE MODE`);
        await copyLegacyGrants(client, legacyGrants);
        const shadowGrants = await inspectGrants(SHADOW_TABLE, client);
        if (!grantsMatch(legacyGrants, shadowGrants)) {
          throw new Error("Nao foi possivel confirmar a copia dos grants para a shadow antes do swap.");
        }
        const markerResult = await client.query(`SELECT count(*)::bigint AS row_count, max(id)::bigint AS max_id, max(created_at) AS max_created_at FROM ml.${SHADOW_TABLE}`);
        const livePartitions = await renameShadowChildrenForLiveParent(client);
        await client.query(`ALTER TABLE ml.${LEGACY_TABLE} RENAME TO ${legacyName}`);
        await client.query(`ALTER TABLE ml.${SHADOW_TABLE} RENAME TO ${LEGACY_TABLE}`);
        await client.query(`ALTER SEQUENCE ml.auth_audit_id_seq OWNED BY ml.${LEGACY_TABLE}.id`);
        return { marker: normalizeMarker(markerResult.rows?.[0]), livePartitions };
      });
      const outcome = { legacyName, marker: marker.marker, livePartitions: marker.livePartitions, grantsCopied: legacyGrants.length };
      await recordOperation({ operationId, kind: "swap", status: "completed", details: outcome });
      return outcome;
    } catch (error) {
      await failOperation(operationId, "swap", error, { legacyName });
      throw error;
    }
  }

  async function swap(options) {
    return withSessionAdvisoryLock(() => swapUnlocked(options));
  }

  async function rollbackUnlocked({ dryRun = false, legacyName } = {}) {
    requireConfirmation("ROLLBACK");
    await requirePreflight();
    let resolvedLegacy = legacyName;
    if (!resolvedLegacy) {
      const latest = await query(`
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
    const exists = await query("SELECT to_regclass($1) IS NOT NULL AS exists", [`ml.${resolvedLegacy}`]);
    if (exists.rows?.[0]?.exists !== true) throw new Error("Rollback indisponivel: tabela legacy nao existe.");
    const operationId = randomUUID();
    const suffix = operationId.replace(/-/g, "").slice(0, 12).toLowerCase();
    const failedName = `auth_audit_partitioned_failed_${suffix}`;
    try {
      const latestSwap = await latestCompleted("swap");
      const marker = latestSwap?.details?.legacyName === resolvedLegacy ? latestSwap.details.marker : null;
      const allowDataLoss = env.AUTH_AUDIT_PARTITION_ALLOW_DATA_LOSS === "YES";
      let risk;
      await recordOperation({ operationId, kind: "rollback", status: "started", details: { legacyName: resolvedLegacy, failedName, marker: marker || null, allowDataLoss } });
      try {
        await transaction(async (client) => {
        await client.query(`LOCK TABLE ml.${LEGACY_TABLE}, ${legacy} IN ACCESS EXCLUSIVE MODE`);
        const markerUsable = marker
          && Number.isFinite(Number(marker.rowCount))
          && (marker.maxId === null || /^\d+$/.test(String(marker.maxId)))
          && (marker.maxCreatedAt === null || !Number.isNaN(new Date(marker.maxCreatedAt).getTime()));
        const activeRows = await client.query(`SELECT count(*)::bigint AS row_count, max(id)::bigint AS max_id, max(created_at) AS max_created_at FROM ml.${LEGACY_TABLE}`);
        const activeMarker = normalizeMarker(activeRows.rows?.[0]);
        const postSwapWrites = markerUsable && (
          activeMarker.rowCount > normalizeCount(marker.rowCount)
          || (marker.maxId !== null && activeMarker.maxId !== null && BigInt(activeMarker.maxId) > BigInt(marker.maxId))
          || (marker.maxCreatedAt !== null && activeMarker.maxCreatedAt !== null && activeMarker.maxCreatedAt > marker.maxCreatedAt)
        );
        risk = {
          marker: marker || null,
          markerState: markerUsable ? "usable" : "missing_or_ambiguous",
          activeMarker,
          postSwapWrites: Boolean(postSwapWrites),
          allowDataLoss,
        };
        if ((risk.markerState !== "usable" || risk.postSwapWrites) && !allowDataLoss) {
          const error = new Error(risk.markerState !== "usable"
            ? "Rollback recusado: marker do swap ausente ou ambiguo. Defina AUTH_AUDIT_PARTITION_ALLOW_DATA_LOSS=YES somente se aceitar esse risco."
            : "Rollback recusado: existem escritas apos o swap. Defina AUTH_AUDIT_PARTITION_ALLOW_DATA_LOSS=YES somente se aceitar perde-las.");
          error.rollbackRisk = risk;
          throw error;
        }
        await client.query(`ALTER TABLE ml.${LEGACY_TABLE} RENAME TO ${failedName}`);
        const archivedLivePartitions = await archiveLiveChildrenAfterRollback(client, failedName);
        await client.query(`ALTER TABLE ${legacy} RENAME TO ${LEGACY_TABLE}`);
        await client.query(`ALTER SEQUENCE ml.auth_audit_id_seq OWNED BY ml.${LEGACY_TABLE}.id`);
        risk.archivedLivePartitions = archivedLivePartitions;
      });
      } catch (error) {
        if (error.rollbackRisk) {
          await recordOperation({ operationId, kind: "rollback", status: "skipped", details: { legacyName: resolvedLegacy, failedName, risk: error.rollbackRisk, decision: error.rollbackRisk.markerState !== "usable" ? "refused_missing_or_ambiguous_marker" : "refused_post_swap_writes" } });
        }
        throw error;
      }
      const outcome = { legacyName: resolvedLegacy, failedName, risk };
      await recordOperation({ operationId, kind: "rollback", status: "completed", details: outcome });
      return outcome;
    } catch (error) {
      await failOperation(operationId, "rollback", error, { legacyName: resolvedLegacy, failedName });
      throw error;
    }
  }

  async function rollback(options) {
    return withSessionAdvisoryLock(() => rollbackUnlocked(options));
  }

  async function statusUnlocked() {
    const [legacy, shadow, operations] = await Promise.all([
      inspectLegacy(),
      query(`SELECT relation.relkind, pg_get_partkeydef(relation.oid) AS partition_key
        FROM pg_catalog.pg_class relation
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = $1 AND relation.relname = $2`, [SCHEMA, SHADOW_TABLE]),
      query("SELECT operation_id, kind, status, details, started_at, completed_at FROM ml.auth_audit_partition_operations ORDER BY created_at DESC LIMIT 20"),
    ]);
    const history = operations.rows || [];
    const preflight = history.find((operation) => operation.kind === "preflight") || null;
    const approval = preflight?.details?.operationalApproval || null;
    const missingOperationalApprovals = approval ? [
      !approval.backupRestored && "backup_restore",
      !approval.maintenanceWindow && "maintenance_window",
      !approval.capacityConfirmed && "free_space",
      approval.capacityEnough === false && "capacity_insufficient",
    ].filter(Boolean) : ["preflight_required"];
    return {
      legacy,
      shadow: shadow.rows?.[0] || null,
      preflight,
      missingOperationalApprovals,
      operations: history,
    };
  }

  async function status() {
    return withSessionAdvisoryLock(statusUnlocked);
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
  const result = command === "preflight"
    ? await cutover.preflight({ operationalApproval: operationApprovalFromEnv(process.env) })
    : await cutover[command]({ dryRun, batchSize });
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
