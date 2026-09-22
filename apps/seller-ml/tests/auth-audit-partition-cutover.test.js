"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createAuthAuditPartitionCutover,
  quoteIdentifier,
} = require("../scripts/authAuditPartitionCutover");

function queryDb(responses = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      const next = responses.shift();
      if (typeof next === "function") return next(sql, params);
      return next || { rows: [], rowCount: 0 };
    },
    async withClient(work) {
      return work(this);
    },
  };
}

function routedDb(route) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return route(String(sql), params) || { rows: [], rowCount: 0 };
    },
    async withClient(work) {
      return work(this);
    },
  };
}

function healthyPreflightResponses() {
  return [
    { rows: [{ relkind: "r", bytes: "2048", row_count: "3", min_created_at: "2026-01-01T00:00:00.000Z", max_created_at: "2026-02-01T00:00:00.000Z" }] },
    { rows: [{ exists: true }] },
    { rows: [{ data_directory: "/var/lib/postgresql/data" }] },
    { rows: expectedColumns() },
    { rows: expectedForeignKeys() },
    { rows: [] },
    { rows: [] },
    { rows: [] },
  ];
}

function expectedColumns() {
  return [
    ["id", "bigint", true, "nextval('ml.auth_audit_id_seq'::regclass)"],
    ["user_id", "bigint", false, null], ["email", "text", false, null],
    ["evento", "text", true, null], ["status", "text", true, "'info'::text"],
    ["ip", "text", false, null], ["user_agent", "text", false, null], ["metadata", "jsonb", false, null],
    ["created_at", "timestamp with time zone", true, "now()"], ["empresa_id", "bigint", false, null], ["meli_conta_id", "bigint", false, null],
  ].map(([attname, data_type, attnotnull, default_expression]) => ({ attname, data_type, attnotnull, default_expression }));
}

function expectedForeignKeys() {
  return [
    { target_table: "usuarios", delete_type: "n" },
    { target_table: "empresas", delete_type: "c" },
    { target_table: "meli_contas", delete_type: "c" },
  ];
}

function approvedPreflight() {
  return { operation_id: "preflight-ok", details: { operationalApproval: { approved: true } } };
}

test("rejeita identificadores fora da lista segura", () => {
  assert.equal(quoteIdentifier("auth_audit_partitioned_new_2026_09"), "ml.auth_audit_partitioned_new_2026_09");
  assert.throws(() => quoteIdentifier("auth_audit; drop table ml.auth_audit"), /invalido/i);
});

test("preflight e somente leitura, registra checklist e libera acoes seguintes", async () => {
  const db = queryDb(healthyPreflightResponses());
  const cutover = createAuthAuditPartitionCutover({ db, randomUUID: () => "00000000-0000-4000-8000-000000000001" });
  const result = await cutover.preflight({ operationalApproval: { backupRestored: true, maintenanceWindow: true, capacityConfirmed: true, availableBytes: 999999999 } });

  assert.equal(result.ok, true);
  const sql = db.calls.map((call) => call.sql).join("\n");
  assert.match(sql, /pg_catalog\.pg_class/i);
  assert.match(sql, /current_setting\('data_directory'/i);
  assert.doesNotMatch(sql, /\b(?:create|alter|delete|update|lock)\b[\s\S]*ml\.auth_audit\b/i);
  assert.ok(result.checklist.some((item) => item.id === "legacy_table" && item.ok));
  assert.equal(result.operationalApproval.approved, true);
});

test("preflight bloqueia copy e swap quando backup, janela ou capacidade nao foram aprovados", async () => {
  const db = routedDb(() => ({ rows: [] }));
  const cutover = createAuthAuditPartitionCutover({ db });
  await assert.rejects(() => cutover.copy(), /Preflight valido/i);
  await assert.rejects(() => cutover.swap(), /AUTH_AUDIT_PARTITION_CONFIRM=SWAP/i);
});

test("status explica quais aprovacoes operacionais ainda faltam", async () => {
  const db = routedDb((sql) => {
    if (/pg_total_relation_size/i.test(sql)) return { rows: [{ relkind: "r" }] };
    if (/relation\.relname = \$2/i.test(sql)) return { rows: [] };
    if (/partition_operations ORDER BY/i.test(sql)) return { rows: [{ kind: "preflight", details: { operationalApproval: { backupRestored: false, maintenanceWindow: true, capacityConfirmed: false, capacityEnough: null } } }] };
    return { rows: [] };
  });
  const result = await createAuthAuditPartitionCutover({ db }).status();
  assert.deepEqual(result.missingOperationalApprovals, ["backup_restore", "free_space"]);
});

test("copy exige preflight, cria shadow particionada com PK composta e nunca apaga legacy", async () => {
  let copied = false;
  const db = routedDb((sql) => {
    if (/kind = \$1 AND status = 'completed'/i.test(sql)) return { rows: [approvedPreflight()] };
    if (/SELECT min\(created_at\)/i.test(sql)) return { rows: [{ min_created_at: "2026-01-01T00:00:00.000Z" }] };
    if (/WITH source AS/i.test(sql) && !copied) { copied = true; return { rows: [{ copied: "2", last_id: "12" }] }; }
    if (/WITH source AS/i.test(sql)) return { rows: [{ copied: "0", last_id: null }] };
    return { rows: [] };
  });
  const cutover = createAuthAuditPartitionCutover({ db, clock: () => new Date("2026-09-22T00:00:00.000Z"), monthsAhead: 1 });
  const result = await cutover.copy({ batchSize: 100 });
  const sql = db.calls.map((call) => call.sql).join("\n");

  assert.equal(result.copied, 2);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ml\.auth_audit_partitioned_new/i);
  assert.match(sql, /PRIMARY KEY \(created_at, id\)/i);
  assert.match(sql, /PARTITION BY RANGE \(created_at\)/i);
  assert.match(sql, /REFERENCES ml\.usuarios\(id\) ON DELETE SET NULL/i);
  assert.match(sql, /REFERENCES ml\.empresas\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /REFERENCES ml\.meli_contas\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /auth_audit_partitioned_new_default/i);
  assert.match(sql, /ON CONFLICT \(created_at, id\) DO NOTHING/i);
  assert.doesNotMatch(sql, /DELETE FROM ml\.auth_audit\b/i);
  assert.doesNotMatch(sql, /DROP TABLE ml\.auth_audit\b/i);
});

test("copy dry run faz preflight de copia sem criar ou inserir", async () => {
  const db = queryDb([{ rows: [approvedPreflight()] }, { rows: [{ min_created_at: null }] }]);
  const cutover = createAuthAuditPartitionCutover({ db });
  const result = await cutover.copy({ dryRun: true });
  const sql = db.calls.map((call) => call.sql).join("\n");

  assert.equal(result.dryRun, true);
  assert.doesNotMatch(sql, /CREATE TABLE|INSERT INTO|DELETE FROM/i);
});

test("verify falha quando contagem ou agregacao mensal diverge", async () => {
  let aggregateCount = 0;
  const db = routedDb((sql) => {
    if (/min\(id\)::bigint/i.test(sql)) {
      aggregateCount += 1;
      return { rows: [{ count: aggregateCount === 1 ? "4" : "3", min_id: "1", max_id: "4", min_created_at: "2026-01-01", max_created_at: "2026-02-01" }] };
    }
    if (/GROUP BY 1, 2/i.test(sql)) return { rows: [{ month_start: "2026-01-01", evento: "login", row_count: "4", checksum: "a" }] };
    if (/parent\.relkind/i.test(sql)) return { rows: [{ relkind: "p", partkey: "RANGE (created_at)", primary_key: "created_at, id", partitions: "20" }] };
    if (/pg_catalog\.pg_attribute/i.test(sql)) return { rows: expectedColumns() };
    if (/constraint_row\.contype = 'f'/i.test(sql)) return { rows: expectedForeignKeys() };
    if (/child\.relname/i.test(sql)) return { rows: [{ relname: "auth_audit_partitioned_new_default", bound: "DEFAULT", row_count: "0" }] };
    if (/role_table_grants/i.test(sql)) return { rows: [] };
    return { rows: [] };
  });
  const cutover = createAuthAuditPartitionCutover({ db });

  await assert.rejects(() => cutover.verify(), /divergencia/i);
});

test("swap exige confirmacao literal e dry run nao bloqueia nem renomeia", async () => {
  const noConfirm = createAuthAuditPartitionCutover({ db: queryDb() });
  await assert.rejects(() => noConfirm.swap(), /AUTH_AUDIT_PARTITION_CONFIRM=SWAP/i);

  const db = routedDb((sql) => (/kind = \$1 AND status = 'completed'/i.test(sql) ? { rows: [approvedPreflight()] } : { rows: [] }));
  const cutover = createAuthAuditPartitionCutover({ db, env: { AUTH_AUDIT_PARTITION_CONFIRM: "SWAP" } });
  const result = await cutover.swap({ dryRun: true });
  assert.equal(result.dryRun, true);
  assert.doesNotMatch(db.calls.map((call) => call.sql).join("\n"), /LOCK TABLE|ALTER TABLE/i);
});

test("swap usa lock e renomeia legacy antes da shadow; rollback faz ordem inversa", async () => {
  const swapDb = routedDb((sql, params) => {
    if (/kind = \$1 AND status = 'completed'/i.test(sql)) return { rows: [params?.[0] === "validate" ? { operation_id: "verify-ok" } : approvedPreflight()] };
    if (/role_table_grants/i.test(sql)) return { rows: [{ grantee: "ml_app", privilege_type: "SELECT" }] };
    if (/row_count, max\(id\)/i.test(sql)) return { rows: [{ row_count: "2", max_id: "12", max_created_at: "2026-01-01" }] };
    return { rows: [] };
  });
  const swap = createAuthAuditPartitionCutover({ db: swapDb, env: { AUTH_AUDIT_PARTITION_CONFIRM: "SWAP" }, randomUUID: () => "00000000-0000-4000-8000-000000000099" });
  await swap.swap();
  const swapSql = swapDb.calls.map((call) => call.sql.replace(/\s+/g, " ").trim());
  const lock = swapSql.findIndex((sql) => /LOCK TABLE ml\.auth_audit, ml\.auth_audit_partitioned_new/i.test(sql));
  const oldName = swapSql.findIndex((sql) => /RENAME TO auth_audit_legacy_00000000/i.test(sql));
  const newName = swapSql.findIndex((sql) => /auth_audit_partitioned_new RENAME TO auth_audit/i.test(sql));
  const grant = swapSql.findIndex((sql) => /GRANT SELECT ON TABLE ml\.auth_audit_partitioned_new TO "ml_app"/i.test(sql));
  assert.ok(lock >= 0 && lock < grant && grant < oldName && oldName < newName);

  const rollbackDb = routedDb((sql, params) => {
    if (/kind = \$1 AND status = 'completed'/i.test(sql)) {
      if (params?.[0] === "swap") return { rows: [{ operation_id: "swap-ok", details: { legacyName: "auth_audit_legacy_000000000099", marker: { rowCount: 2, maxId: "12", maxCreatedAt: "2026-01-01T00:00:00.000Z" } } }] };
      return { rows: [approvedPreflight()] };
    }
    if (/relation\.relname ~ '\^auth_audit_legacy/i.test(sql)) return { rows: [{ relname: "auth_audit_legacy_000000000099" }] };
    if (/to_regclass\(\$1\)/i.test(sql)) return { rows: [{ exists: true }] };
    if (/row_count, max\(id\)/i.test(sql)) return { rows: [{ row_count: "2", max_id: "12", max_created_at: "2026-01-01" }] };
    return { rows: [] };
  });
  const rollback = createAuthAuditPartitionCutover({ db: rollbackDb, env: { AUTH_AUDIT_PARTITION_CONFIRM: "ROLLBACK" } });
  await rollback.rollback();
  const rollbackSql = rollbackDb.calls.map((call) => call.sql.replace(/\s+/g, " ").trim());
  const rollbackLock = rollbackSql.findIndex((sql) => /LOCK TABLE ml\.auth_audit, ml\.auth_audit_legacy/i.test(sql));
  const archivedNew = rollbackSql.findIndex((sql) => /auth_audit RENAME TO auth_audit_partitioned_failed/i.test(sql));
  const restoreLegacy = rollbackSql.findIndex((sql) => /auth_audit_legacy_[a-f0-9]{12} RENAME TO auth_audit/i.test(sql));
  assert.ok(rollbackLock >= 0 && rollbackLock < archivedNew && archivedNew < restoreLegacy);
});

test("rollback recusa perda de escritas posteriores sem flag literal e registra decisao", async () => {
  const db = routedDb((sql, params) => {
    if (/kind = \$1 AND status = 'completed'/i.test(sql)) {
      if (params?.[0] === "swap") return { rows: [{ operation_id: "swap-ok", details: { legacyName: "auth_audit_legacy_000000000099", marker: { rowCount: 2, maxId: "12", maxCreatedAt: "2026-01-01T00:00:00.000Z" } } }] };
      return { rows: [approvedPreflight()] };
    }
    if (/relation\.relname ~ '\^auth_audit_legacy/i.test(sql)) return { rows: [{ relname: "auth_audit_legacy_000000000099" }] };
    if (/to_regclass\(\$1\)/i.test(sql)) return { rows: [{ exists: true }] };
    if (/row_count, max\(id\)/i.test(sql)) return { rows: [{ row_count: "3", max_id: "13", max_created_at: "2026-01-02" }] };
    return { rows: [] };
  });
  const cutover = createAuthAuditPartitionCutover({ db, env: { AUTH_AUDIT_PARTITION_CONFIRM: "ROLLBACK" } });

  await assert.rejects(() => cutover.rollback(), /AUTH_AUDIT_PARTITION_ALLOW_DATA_LOSS=YES/i);
  const sql = db.calls.map((call) => call.sql).join("\n");
  assert.doesNotMatch(sql, /LOCK TABLE|RENAME TO auth_audit_partitioned_failed/i);
  assert.ok(db.calls.some((call) => /INSERT INTO ml\.auth_audit_partition_operations/i.test(call.sql) && call.params?.[2] === "skipped"));
});
