const { randomUUID: systemRandomUUID } = require("node:crypto");

const PARTITION_NAME = /^auth_audit_(\d{4})_(\d{2})$/;
const DEFAULT_PARTITION = "auth_audit_default";
const OPERATION_KINDS = new Set(["preflight", "copy", "validate", "swap", "rollback", "maintenance"]);
const OPERATION_STATUSES = new Set(["started", "completed", "failed", "skipped"]);

function monthBoundsUtc(date) {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) throw new Error("Data mensal invalida.");
  const from = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
  const to = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1));
  return { from, to };
}

function partitionNameForMonth(date) {
  const { from } = monthBoundsUtc(date);
  return `auth_audit_${from.getUTCFullYear()}_${String(from.getUTCMonth() + 1).padStart(2, "0")}`;
}

function isMonthlyPartitionName(name) {
  const match = PARTITION_NAME.exec(String(name || ""));
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

function quotePartition(name) {
  if (!isMonthlyPartitionName(name)) throw new Error("Nome de particao mensal invalido.");
  return `ml.${name}`;
}

function asCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function listPartitionsQuery() {
  return `
    SELECT child.relname, pg_get_expr(child.relpartbound, child.oid) AS bound
      FROM pg_catalog.pg_inherits inheritance
      JOIN pg_catalog.pg_class parent ON parent.oid = inheritance.inhparent
      JOIN pg_catalog.pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
      JOIN pg_catalog.pg_class child ON child.oid = inheritance.inhrelid
     WHERE parent_ns.nspname = $1
       AND parent.relname = $2
     ORDER BY child.relname`;
}

function createAuthAuditPartitionService({
  db,
  clock = () => new Date(),
  monthsAhead = 18,
  cleanupAuthAudit,
  randomUUID = systemRandomUUID,
} = {}) {
  if (!db || typeof db.query !== "function") throw new Error("db.query e obrigatorio.");
  const futureMonths = Math.max(0, Number.isInteger(monthsAhead) ? monthsAhead : 18);

  async function inspectCurrentTable() {
    const result = await db.query(`
      SELECT table_class.relkind,
             pg_catalog.pg_get_partkeydef(table_class.oid) AS partition_key
        FROM pg_catalog.pg_class table_class
        JOIN pg_catalog.pg_namespace table_schema ON table_schema.oid = table_class.relnamespace
       WHERE table_schema.nspname = $1
         AND table_class.relname = $2`, ["ml", "auth_audit"]);
    const row = result.rows?.[0] || null;
    const partitionKey = String(row?.partition_key || "");
    return {
      exists: Boolean(row),
      relkind: row?.relkind || null,
      partitionKey: row?.partition_key || null,
      partitioned: row?.relkind === "p" && /created_at/i.test(partitionKey),
    };
  }

  async function listPartitions() {
    const result = await db.query(listPartitionsQuery(), ["ml", "auth_audit"]);
    return (result.rows || []).map((row) => ({
      name: String(row.relname || ""),
      bound: String(row.bound || ""),
      isDefault: String(row.relname || "") === DEFAULT_PARTITION || /\bDEFAULT\b/i.test(String(row.bound || "")),
    }));
  }

  async function createMonthlyPartition(date, executor = db) {
    const { from, to } = monthBoundsUtc(date);
    const name = partitionNameForMonth(from);
    await executor.query(
      `CREATE TABLE IF NOT EXISTS ${quotePartition(name)} PARTITION OF ml.auth_audit
         FOR VALUES FROM ('${from.toISOString()}') TO ('${to.toISOString()}')`,
    );
    return name;
  }

  async function moveDefaultRange(executor, date, batchSize = 10000) {
    const bounds = monthBoundsUtc(date);
    const safeBatchSize = Math.max(1, Number(batchSize) || 10000);
    let moved = 0;
    let batchMoved;
    do {
      const result = await executor.query(`
        WITH moved AS (
          DELETE FROM ml.${DEFAULT_PARTITION}
           WHERE ctid IN (
             SELECT ctid
               FROM ml.${DEFAULT_PARTITION}
              WHERE created_at >= $1
                AND created_at < $2
              ORDER BY created_at, id
              LIMIT $3
           )
           RETURNING *
        ), inserted AS (
          INSERT INTO ml.auth_audit SELECT * FROM moved
          RETURNING 1
        )
        SELECT count(*)::bigint AS moved_count FROM inserted`, [
        bounds.from.toISOString(),
        bounds.to.toISOString(),
        safeBatchSize,
      ]);
      batchMoved = asCount(result.rows?.[0]?.moved_count);
      moved += batchMoved;
    } while (batchMoved === safeBatchSize);
    return moved;
  }

  async function inTransaction(work) {
    const run = async (client) => {
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
    if (typeof db.withClient === "function") return db.withClient(run);
    return run(db);
  }

  async function createWithDetachedDefault(months, { moveRows = true, batchSize = 10000 } = {}) {
    return inTransaction(async (client) => {
      await client.query("LOCK TABLE ml.auth_audit IN ACCESS EXCLUSIVE MODE");
      await client.query(`ALTER TABLE ml.auth_audit DETACH PARTITION ml.${DEFAULT_PARTITION}`);
      let moved = 0;
      try {
        for (const month of months) {
          await createMonthlyPartition(month, client);
          if (moveRows) moved += await moveDefaultRange(client, month, batchSize);
        }
        await client.query(`ALTER TABLE ml.auth_audit ATTACH PARTITION ml.${DEFAULT_PARTITION} DEFAULT`);
      } catch (error) {
        throw error;
      }
      return moved;
    });
  }

  async function ensurePartitions() {
    const parent = await inspectCurrentTable();
    if (!parent.partitioned) return { applied: false, reason: "parent_not_partitioned", parent, partitions: [] };

    const current = monthBoundsUtc(clock()).from;
    const requestedMonths = [];
    for (let offset = 0; offset <= futureMonths; offset += 1) {
      requestedMonths.push(new Date(Date.UTC(
        current.getUTCFullYear(), current.getUTCMonth() + offset, 1,
      )));
    }
    const existing = await listPartitions();
    const existingNames = new Set(existing.map((partition) => partition.name));
    const missingMonths = requestedMonths.filter((month) => !existingNames.has(partitionNameForMonth(month)));
    const defaultPresent = existing.some((partition) => partition.name === DEFAULT_PARTITION && partition.isDefault);
    if (!defaultPresent) {
      await inTransaction(async (client) => {
        await client.query("LOCK TABLE ml.auth_audit IN ACCESS EXCLUSIVE MODE");
        for (const month of missingMonths) await createMonthlyPartition(month, client);
        await client.query(`CREATE TABLE IF NOT EXISTS ml.${DEFAULT_PARTITION} PARTITION OF ml.auth_audit DEFAULT`);
      });
    } else if (missingMonths.length > 0) {
      await createWithDetachedDefault(missingMonths);
    }
    return {
      applied: true,
      parent,
      defaultPartition: DEFAULT_PARTITION,
      partitions: requestedMonths.map(partitionNameForMonth),
    };
  }

  async function drainDefaultPartition({ batchSize = 10000 } = {}) {
    const parent = await inspectCurrentTable();
    if (!parent.partitioned) return { applied: false, reason: "parent_not_partitioned", parent, moved: 0 };
    const partitions = await listPartitions();
    if (!partitions.some((partition) => partition.name === DEFAULT_PARTITION && partition.isDefault)) {
      return { applied: false, reason: "default_partition_missing", parent, moved: 0 };
    }
    const outcome = await inTransaction(async (client) => {
      await client.query("LOCK TABLE ml.auth_audit IN ACCESS EXCLUSIVE MODE");
      await client.query(`ALTER TABLE ml.auth_audit DETACH PARTITION ml.${DEFAULT_PARTITION}`);
      const groups = await client.query(`
        SELECT date_trunc('month', created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS month_start,
               count(*) AS row_count
          FROM ml.${DEFAULT_PARTITION}
         GROUP BY 1
         ORDER BY 1`);
      let moved = 0;
      const months = [];
      for (const group of groups.rows || []) {
        const month = new Date(group.month_start);
        if (Number.isNaN(month.getTime())) continue;
        const name = partitionNameForMonth(month);
        const existingMonthly = partitions.some((partition) => partition.name === name);
        if (!existingMonthly) await createMonthlyPartition(month, client);
        months.push(name);
        moved += await moveDefaultRange(client, month, batchSize);
      }
      await client.query(`ALTER TABLE ml.auth_audit ATTACH PARTITION ml.${DEFAULT_PARTITION} DEFAULT`);
      return { moved, months };
    });
    return { applied: true, parent, moved: outcome.moved, months: [...new Set(outcome.months)] };
  }

  async function pruneExpiredPartitions({ confirmDrop = false } = {}) {
    if (typeof cleanupAuthAudit === "function") await cleanupAuthAudit();
    const parent = await inspectCurrentTable();
    if (!parent.partitioned) return { applied: false, reason: "parent_not_partitioned", parent, eligible: [], dropped: [] };

    const nowMonth = monthBoundsUtc(clock()).from;
    const partitions = await listPartitions();
    const eligible = [];
    const dropped = [];
    for (const partition of partitions) {
      if (partition.isDefault || !isMonthlyPartitionName(partition.name)) continue;
      const match = PARTITION_NAME.exec(partition.name);
      const month = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
      if (month >= nowMonth) continue;
      const nextMonth = monthBoundsUtc(month).to;
      if (nextMonth > nowMonth) continue;
      const table = quotePartition(partition.name);
      const canDrop = async (executor) => {
        const result = await executor.query(`
        SELECT NOT EXISTS (
          SELECT 1
            FROM ${table} audit
            LEFT JOIN LATERAL (
              SELECT retention_days
                FROM ml.auth_audit_retention_rules rule
               WHERE rule.evento IN (audit.evento, '*')
               ORDER BY CASE WHEN rule.evento = audit.evento THEN 0 ELSE 1 END
               LIMIT 1
            ) retention ON true
           WHERE retention.retention_days IS NULL
              OR audit.created_at >= now() - make_interval(days => retention.retention_days)
        ) AS safe_to_drop`);
        return result.rows?.[0]?.safe_to_drop === true;
      };
      if (confirmDrop !== true) {
        if (await canDrop(db)) eligible.push(partition.name);
        continue;
      }
      const didDrop = await inTransaction(async (client) => {
        await client.query("LOCK TABLE ml.auth_audit IN ACCESS EXCLUSIVE MODE");
        if (!await canDrop(client)) return false;
        await client.query(`ALTER TABLE ml.auth_audit DETACH PARTITION ${table}`);
        await client.query(`DROP TABLE IF EXISTS ${table}`);
        return true;
      });
      if (!didDrop) continue;
      eligible.push(partition.name);
      dropped.push(partition.name);
    }
    return { applied: true, parent, dryRun: confirmDrop !== true, eligible, dropped };
  }

  async function verifyPartitionedAudit() {
    const parent = await inspectCurrentTable();
    const partitions = await listPartitions();
    const defaultPresent = partitions.some((partition) => partition.name === DEFAULT_PARTITION && partition.isDefault);
    let defaultRows = null;
    if (defaultPresent) {
      const result = await db.query(`SELECT count(*)::bigint AS row_count FROM ml.${DEFAULT_PARTITION}`);
      defaultRows = asCount(result.rows?.[0]?.row_count);
    }
    return { parent, partitions, defaultPresent, defaultRows, defaultDrained: defaultRows === 0 };
  }

  async function recordOperation({ operationId = randomUUID(), kind, status, details = {}, completedAt } = {}) {
    if (!OPERATION_KINDS.has(kind)) throw new Error("Tipo de operacao de particionamento invalido.");
    if (!OPERATION_STATUSES.has(status)) throw new Error("Status de operacao de particionamento invalido.");
    const isFinal = status === "completed" || status === "failed" || status === "skipped";
    const result = await db.query(`
      INSERT INTO ml.auth_audit_partition_operations (operation_id, kind, status, details, completed_at)
      VALUES ($1, $2, $3, $4::jsonb, $5)
      ON CONFLICT (operation_id) DO UPDATE
        SET kind = EXCLUDED.kind,
            status = EXCLUDED.status,
            details = EXCLUDED.details,
            completed_at = EXCLUDED.completed_at
      RETURNING operation_id, kind, status, details, started_at, completed_at`, [
      operationId,
      kind,
      status,
      JSON.stringify(details || {}),
      completedAt || (isFinal ? new Date(clock()).toISOString() : null),
    ]);
    return { operationId, ...(result.rows?.[0] || {}) };
  }

  return {
    inspectCurrentTable,
    ensurePartitions,
    drainDefaultPartition,
    pruneExpiredPartitions,
    verifyPartitionedAudit,
    recordOperation,
  };
}

module.exports = {
  DEFAULT_PARTITION,
  PARTITION_NAME,
  createAuthAuditPartitionService,
  isMonthlyPartitionName,
  monthBoundsUtc,
  partitionNameForMonth,
};
