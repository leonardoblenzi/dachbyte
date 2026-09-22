"use strict";

// Contract-level integration coverage for the three entry points.  These tests
// deliberately use an in-process Postgres contract instead of a real database:
// the cutover is only allowed during the approved VPS maintenance window.
const assert = require("node:assert/strict");
const test = require("node:test");

const { createAuthAuditPartitionService } = require("../services/authAuditPartitionService");
const { createAuthAuditPartitionScheduler } = require("../services/authAuditPartitionScheduler");
const { createAuthAuditPartitionCutover, quoteIdentifier } = require("../scripts/authAuditPartitionCutover");

function contractDb(route) {
  const calls = [];
  const db = {
    calls,
    async query(sql, params) {
      const call = { sql: String(sql), params };
      calls.push(call);
      if (/pg_advisory_(?:xact_)?(?:lock|unlock)/i.test(call.sql)) return { rows: [] };
      return route(call, calls) || { rows: [], rowCount: 0 };
    },
    async withClient(work) { return work(db); },
  };
  return db;
}

function approvedPreflight() {
  return { operation_id: "preflight-ok", details: { mode: "cutover", operationalApproval: { approved: true } } };
}

function approvedCopy() {
  return { operation_id: "copy-ok", details: { shadowTable: "auth_audit_partitioned_new" } };
}

test("pre-corte: scheduler consulta o catalogo e nao emite DDL/DML", async () => {
  const db = contractDb((call) => {
    if (/pg_get_partkeydef/i.test(call.sql)) return { rows: [{ relkind: "r", partition_key: null }] };
    return { rows: [] };
  });
  const service = createAuthAuditPartitionService({ db });
  const scheduler = createAuthAuditPartitionScheduler({ service, logger: { info() {}, error() {} } });

  const result = await scheduler.run();
  const sql = db.calls.map((call) => call.sql).join("\n");
  assert.equal(result.reason, "parent_not_partitioned");
  assert.doesNotMatch(sql, /\b(?:create|alter|insert|delete|drop|update)\b/i);
});

test("corte: swap so ocorre apos preflight+copy+verify e faz catch-up antes de renomear", async () => {
  const db = contractDb((call) => {
    if (/kind = \$1 AND status = 'completed'/i.test(call.sql)) {
      if (call.params?.[0] === "validate") return { rows: [{ operation_id: "validate-ok", details: { shadowTable: "auth_audit_partitioned_new", copyOperationId: "copy-ok" } }] };
      if (call.params?.[0] === "copy") return { rows: [approvedCopy()] };
      return { rows: [approvedPreflight()] };
    }
    if (/role_table_grants/i.test(call.sql)) return { rows: [] };
    // This represents an audit event written after verify and before the lock.
    if (/WITH final_delta/i.test(call.sql)) return { rows: [{ copied: "1" }] };
    if (/legacy_count/i.test(call.sql)) return { rows: [{ legacy_count: "4", shadow_count: "4", legacy_min_id: "1", shadow_min_id: "1", legacy_max_id: "13", shadow_max_id: "13", legacy_empresa_count: "2", shadow_empresa_count: "2", legacy_meli_conta_count: "2", shadow_meli_conta_count: "2" }] };
    if (/row_count, max\(id\)/i.test(call.sql)) return { rows: [{ row_count: "4", max_id: "13", max_created_at: "2026-09-22T12:00:00.000Z" }] };
    if (/FROM pg_catalog\.pg_inherits/i.test(call.sql) && /parent\.relname = \$2/i.test(call.sql)) {
      return { rows: [{ relname: "auth_audit_partitioned_new_2026_09" }, { relname: "auth_audit_partitioned_new_default" }] };
    }
    return { rows: [] };
  });
  const cutover = createAuthAuditPartitionCutover({
    db,
    env: { AUTH_AUDIT_PARTITION_CONFIRM: "SWAP" },
    randomUUID: () => "00000000-0000-4000-8000-000000000111",
  });

  const result = await cutover.swap();
  const sql = db.calls.map((call) => call.sql.replace(/\s+/g, " ").trim());
  const catchUp = sql.findIndex((statement) => /WITH final_delta/i.test(statement));
  const childMonth = sql.findIndex((statement) => /auth_audit_partitioned_new_2026_09 RENAME TO auth_audit_2026_09/i.test(statement));
  const childDefault = sql.findIndex((statement) => /auth_audit_partitioned_new_default RENAME TO auth_audit_default/i.test(statement));
  const legacyRename = sql.findIndex((statement) => /auth_audit RENAME TO auth_audit_legacy_00000000/i.test(statement));
  const parentRename = sql.findIndex((statement) => /auth_audit_partitioned_new RENAME TO auth_audit/i.test(statement));

  assert.equal(result.catchUp.copied, 1);
  assert.deepEqual(result.livePartitions, ["auth_audit_2026_09", "auth_audit_default"]);
  assert.ok(catchUp >= 0 && catchUp < childMonth && childMonth < childDefault && childDefault < legacyRename && legacyRename < parentRename);
});

test("pos-corte: scheduler garante/draina e mantem prune em dry-run com retencao dinamica", async () => {
  const calls = [];
  const scheduler = createAuthAuditPartitionScheduler({
    service: {
      async inspectCurrentTable() { calls.push("inspect"); return { partitioned: true }; },
      async ensurePartitions() { calls.push("ensure"); return { applied: true, partitions: ["auth_audit_2026_09"] }; },
      async drainDefaultPartition() { calls.push("drain"); return { applied: true, moved: 2 }; },
      async pruneExpiredPartitions(options) {
        calls.push(["prune", options]);
        // The service invokes cleanupAuthAudit first, which reads the Master-configured
        // auth_audit_retention_rules; scheduler must never authorize DROP.
        return { applied: true, dryRun: options.confirmDrop !== true, eligible: ["auth_audit_2026_06"], dropped: [] };
      },
      async verifyPartitionedAudit() { calls.push("verify"); return { defaultDrained: true }; },
    },
    logger: { info() {}, error() {} },
  });

  const result = await scheduler.run();
  assert.equal(result.pruned.dryRun, true);
  assert.deepEqual(result.pruned.dropped, []);
  assert.deepEqual(calls, ["inspect", "ensure", "drain", ["prune", { confirmDrop: false }], "verify"]);
});

test("rollback e release legacy conservam barreiras contra perda de dados", async () => {
  const rollbackDb = contractDb((call) => {
    if (/kind = \$1 AND status = 'completed'/i.test(call.sql)) {
      if (call.params?.[0] === "swap") return { rows: [{ operation_id: "swap-ok", details: { legacyName: "auth_audit_legacy_000000000111", marker: { rowCount: 2, maxId: "12", maxCreatedAt: "2026-09-20T00:00:00.000Z" } } }] };
      return { rows: [approvedPreflight()] };
    }
    if (/relation\.relname ~ '\^auth_audit_legacy/i.test(call.sql)) return { rows: [{ relname: "auth_audit_legacy_000000000111" }] };
    if (/to_regclass\(\$1\)/i.test(call.sql)) return { rows: [{ exists: true }] };
    if (/row_count, max\(id\)/i.test(call.sql)) return { rows: [{ row_count: "3", max_id: "13", max_created_at: "2026-09-22T00:00:00.000Z" }] };
    return { rows: [] };
  });
  const rollback = createAuthAuditPartitionCutover({ db: rollbackDb, env: { AUTH_AUDIT_PARTITION_CONFIRM: "ROLLBACK" } });
  await assert.rejects(() => rollback.rollback(), /ALLOW_DATA_LOSS=YES/i);
  assert.ok(rollbackDb.calls.some((call) => /partition_operations/i.test(call.sql) && call.params?.[2] === "skipped"));
  assert.doesNotMatch(rollbackDb.calls.map((call) => call.sql).join("\n"), /RENAME TO auth_audit_partitioned_failed/i);

  const releaseDb = contractDb((call) => {
    if (/kind = \$1 AND status = 'completed'/i.test(call.sql)) {
      if (call.params?.[0] === "preflight") return { rows: [{ ...approvedPreflight(), completed_at: "2026-09-22T12:00:00.000Z", details: { mode: "release_legacy", operationalApproval: { approved: true } } }] };
      if (call.params?.[0] === "swap") return { rows: [{ operation_id: "swap-ok", completed_at: "2026-09-21T12:00:00.000Z", details: { legacyName: "auth_audit_legacy_000000000111" } }] };
    }
    if (/to_regclass\(\$1\)/i.test(call.sql)) return { rows: [{ exists: true }] };
    if (/relation\.relname = \$2/i.test(call.sql)) return { rows: [{ relkind: "p" }] };
    return { rows: [] };
  });
  const release = createAuthAuditPartitionCutover({
    db: releaseDb,
    env: { AUTH_AUDIT_PARTITION_CONFIRM: "RELEASE_LEGACY" },
    clock: () => new Date("2026-09-23T11:59:59.000Z"),
  });
  await assert.rejects(() => release.releaseLegacy(), /48 horas/i);
  assert.doesNotMatch(releaseDb.calls.map((call) => call.sql).join("\n"), /DROP TABLE/i);
});

test("identificadores hostis e falha de ledger nao liberam operacoes", async () => {
  assert.throws(() => quoteIdentifier("auth_audit; DROP TABLE ml.auth_audit"), /invalido/i);
  const db = contractDb((call) => {
    if (/kind = \$1 AND status = 'completed'/i.test(call.sql)) return { rows: [approvedPreflight()] };
    if (/SELECT min\(created_at\)/i.test(call.sql)) return { rows: [{ min_created_at: "2026-09-01T00:00:00.000Z" }] };
    if (/INSERT INTO ml\.auth_audit_partition_operations/i.test(call.sql)) throw new Error("ledger unavailable");
    return { rows: [] };
  });
  const cutover = createAuthAuditPartitionCutover({ db, logger: { warn() {} } });
  await assert.rejects(() => cutover.copy(), /ledger unavailable/i);
  assert.doesNotMatch(db.calls.map((call) => call.sql).join("\n"), /DROP TABLE ml\.auth_audit\b/i);
});
