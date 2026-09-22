"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createAuthAuditPartitionCutover,
  quoteIdentifier,
  parseArgs,
} = require("../scripts/authAuditPartitionCutover");

function queryDb(responses = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/pg_advisory_(?:xact_)?(?:lock|unlock)/i.test(String(sql))) return { rows: [] };
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

function approvedPreflight(mode = "cutover") {
  return { operation_id: "preflight-ok", details: { mode, operationalApproval: { approved: true } } };
}

function approvedCopy() {
  return { operation_id: "copy-ok", details: { shadowTable: "auth_audit_partitioned_new" } };
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

test("preflight exige capacidade mensurada ou override numerico suficiente", async () => {
  const noCapacityDb = queryDb(healthyPreflightResponses());
  const noCapacity = createAuthAuditPartitionCutover({
    db: noCapacityDb,
    diskInspector: async () => ({ availableBytes: null, source: "unavailable" }),
  });
  await assert.rejects(
    () => noCapacity.preflight({ operationalApproval: { backupRestored: true, maintenanceWindow: true, capacityConfirmed: true } }),
    /Preflight invalido/i,
  );

  const measuredDb = queryDb(healthyPreflightResponses());
  const measured = createAuthAuditPartitionCutover({
    db: measuredDb,
    diskInspector: async () => ({ availableBytes: 4096, source: "node_statfs" }),
  });
  const result = await measured.preflight({ operationalApproval: { backupRestored: true, maintenanceWindow: true, capacityConfirmed: true } });
  assert.equal(result.operationalApproval.capacitySource, "node_statfs");
  assert.equal(result.operationalApproval.requiredBytes, 2663);
  assert.equal(result.operationalApproval.capacityEnough, true);
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

test("status distingue capacidade nao mensurada de espaco insuficiente", async () => {
  const db = routedDb((sql) => {
    if (/pg_total_relation_size/i.test(sql)) return { rows: [{ relkind: "r" }] };
    if (/relation\.relname = \$2/i.test(sql)) return { rows: [] };
    if (/partition_operations ORDER BY/i.test(sql)) {
      return { rows: [{ kind: "preflight", details: { operationalApproval: { backupRestored: true, maintenanceWindow: true, capacityConfirmed: true, capacityEnough: null } } }] };
    }
    return { rows: [] };
  });
  const result = await createAuthAuditPartitionCutover({ db }).status();
  assert.deepEqual(result.missingOperationalApprovals, ["capacity_unmeasured_or_invalid"]);
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
  assert.match(sql, /auth_audit_partitioned_new_metadata_mlb_id_upper_idx/i);
  assert.match(sql, /upper\(metadata\s*->>\s*'mlb_id'\)/i);
  assert.match(sql, /auth_audit_partitioned_new_metadata_item_id_upper_idx/i);
  assert.match(sql, /auth_audit_partitioned_new_metadata_promotion_id_upper_idx/i);
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
  const db = routedDb((sql, params) => {
    if (/kind = \$1 AND status = 'completed'/i.test(sql) && params?.[0] === "copy") return { rows: [approvedCopy()] };
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

test("verify falha quando referencias de empresa ou conta ML divergem", async () => {
  const db = routedDb((sql, params) => {
    if (/kind = \$1 AND status = 'completed'/i.test(sql) && params?.[0] === "copy") return { rows: [approvedCopy()] };
    if (/min\(id\)::bigint/i.test(sql)) return { rows: [{ count: "4", min_id: "1", max_id: "4", min_created_at: "2026-01-01", max_created_at: "2026-02-01" }] };
    if (/GROUP BY 1, 2/i.test(sql)) return { rows: [{ month_start: "2026-01-01", evento: "login", row_count: "4", checksum: "a" }] };
    if (/legacy_empresa_count/i.test(sql)) return { rows: [{ legacy_empresa_count: "3", shadow_empresa_count: "2", legacy_meli_conta_count: "2", shadow_meli_conta_count: "2" }] };
    if (/parent\.relkind/i.test(sql)) return { rows: [{ relkind: "p", partkey: "RANGE (created_at)", primary_key: "created_at, id", partitions: "20" }] };
    if (/pg_catalog\.pg_attribute/i.test(sql)) return { rows: expectedColumns() };
    if (/constraint_row\.contype = 'f'/i.test(sql)) return { rows: expectedForeignKeys() };
    if (/child\.relname/i.test(sql)) return { rows: [{ relname: "auth_audit_partitioned_new_default", bound: "DEFAULT", row_count: "0" }] };
    if (/role_table_grants/i.test(sql)) return { rows: [] };
    return { rows: [] };
  });
  await assert.rejects(() => createAuthAuditPartitionCutover({ db }).verify(), /empresa_id_count/i);
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

test("swap recusa validate ligado a copy antigo antes de adquirir lock de tabela", async () => {
  const db = routedDb((sql, params) => {
    if (/kind = \$1 AND status = 'completed'/i.test(sql)) {
      if (params?.[0] === "validate") return { rows: [{ operation_id: "validate-old", details: { shadowTable: "auth_audit_partitioned_new", copyOperationId: "copy-old" } }] };
      if (params?.[0] === "copy") return { rows: [{ operation_id: "copy-current", details: { shadowTable: "auth_audit_partitioned_new" } }] };
      return { rows: [approvedPreflight()] };
    }
    return { rows: [] };
  });
  const cutover = createAuthAuditPartitionCutover({ db, env: { AUTH_AUDIT_PARTITION_CONFIRM: "SWAP" } });
  await assert.rejects(() => cutover.swap(), /mesma shadow e do copy mais recente/i);
  assert.doesNotMatch(db.calls.map((call) => call.sql).join("\n"), /LOCK TABLE/i);
});

test("swap faz catch-up final sob lock e recusa divergencia antes de renomear", async () => {
  const db = routedDb((sql, params) => {
    if (/kind = \$1 AND status = 'completed'/i.test(sql)) {
      if (params?.[0] === "validate") return { rows: [{ operation_id: "validate-ok", details: { shadowTable: "auth_audit_partitioned_new", copyOperationId: "copy-ok" } }] };
      if (params?.[0] === "copy") return { rows: [approvedCopy()] };
      return { rows: [approvedPreflight()] };
    }
    if (/role_table_grants/i.test(sql)) return { rows: [] };
    if (/WITH final_delta/i.test(sql)) return { rows: [{ copied: "1" }] };
    if (/legacy_count/i.test(sql)) return { rows: [{ legacy_count: "4", shadow_count: "3", legacy_min_id: "1", shadow_min_id: "1", legacy_max_id: "13", shadow_max_id: "12", legacy_empresa_count: "2", shadow_empresa_count: "2", legacy_meli_conta_count: "2", shadow_meli_conta_count: "2" }] };
    return { rows: [] };
  });
  const cutover = createAuthAuditPartitionCutover({ db, env: { AUTH_AUDIT_PARTITION_CONFIRM: "SWAP" } });
  await assert.rejects(() => cutover.swap(), /Catch-up final encontrou divergencia/i);
  const sql = db.calls.map((call) => call.sql).join("\n");
  assert.match(sql, /LOCK TABLE ml\.auth_audit, ml\.auth_audit_partitioned_new/i);
  assert.match(sql, /WITH final_delta/i);
  assert.doesNotMatch(sql, /ALTER TABLE ml\.auth_audit RENAME TO auth_audit_legacy/i);
});

test("swap usa lock e renomeia legacy antes da shadow; rollback faz ordem inversa", async () => {
  const swapDb = routedDb((sql, params) => {
    if (/kind = \$1 AND status = 'completed'/i.test(sql)) {
      if (params?.[0] === "validate") return { rows: [{ operation_id: "verify-ok", details: { copyOperationId: "copy-ok", shadowTable: "auth_audit_partitioned_new" } }] };
      if (params?.[0] === "copy") return { rows: [approvedCopy()] };
      return { rows: [approvedPreflight()] };
    }
    if (/role_table_grants/i.test(sql)) return { rows: [{ grantee: "ml_app", privilege_type: "SELECT" }] };
    if (/WITH final_delta/i.test(sql)) return { rows: [{ copied: "1" }] };
    if (/legacy_count/i.test(sql)) return { rows: [{ legacy_count: "3", shadow_count: "3", legacy_min_id: "1", shadow_min_id: "1", legacy_max_id: "12", shadow_max_id: "12", legacy_empresa_count: "2", shadow_empresa_count: "2", legacy_meli_conta_count: "2", shadow_meli_conta_count: "2" }] };
    if (/row_count, max\(id\)/i.test(sql)) return { rows: [{ row_count: "2", max_id: "12", max_created_at: "2026-01-01" }] };
    if (/FROM pg_catalog\.pg_inherits/i.test(sql) && /parent\.relname = \$2/i.test(sql)) {
      return { rows: [{ relname: "auth_audit_partitioned_new_2026_01" }, { relname: "auth_audit_partitioned_new_default" }] };
    }
    return { rows: [] };
  });
  const swap = createAuthAuditPartitionCutover({ db: swapDb, env: { AUTH_AUDIT_PARTITION_CONFIRM: "SWAP" }, randomUUID: () => "00000000-0000-4000-8000-000000000099" });
  const swapOutcome = await swap.swap();
  const swapSql = swapDb.calls.map((call) => call.sql.replace(/\s+/g, " ").trim());
  const lock = swapSql.findIndex((sql) => /LOCK TABLE ml\.auth_audit, ml\.auth_audit_partitioned_new/i.test(sql));
  const begin = swapSql.findIndex((sql) => sql === "BEGIN");
  const xactLock = swapSql.findIndex((sql) => /pg_advisory_xact_lock\(hashtext/i.test(sql));
  const oldName = swapSql.findIndex((sql) => /RENAME TO auth_audit_legacy_00000000/i.test(sql));
  const newName = swapSql.findIndex((sql) => /auth_audit_partitioned_new RENAME TO auth_audit/i.test(sql));
  const childMonth = swapSql.findIndex((sql) => /auth_audit_partitioned_new_2026_01 RENAME TO auth_audit_2026_01/i.test(sql));
  const childDefault = swapSql.findIndex((sql) => /auth_audit_partitioned_new_default RENAME TO auth_audit_default/i.test(sql));
  const grant = swapSql.findIndex((sql) => /GRANT SELECT ON TABLE ml\.auth_audit_partitioned_new TO "ml_app"/i.test(sql));
  const catchUp = swapSql.findIndex((sql) => /WITH final_delta AS/i.test(sql));
  const legacyIndex = swapSql.findIndex((sql) => /ALTER INDEX ml\.auth_audit_metadata_mlb_id_upper_idx RENAME TO auth_audit_legacy/i.test(sql));
  const finalIndex = swapSql.findIndex((sql) => /ALTER INDEX ml\.auth_audit_partitioned_new_metadata_mlb_id_upper_idx RENAME TO auth_audit_metadata_mlb_id_upper_idx/i.test(sql));
  assert.equal(swapOutcome.catchUp.copied, 1);
  assert.ok(begin >= 0 && begin < xactLock && xactLock < lock && lock < grant && grant < catchUp && catchUp < childMonth && childMonth < childDefault && childDefault < oldName && oldName < newName && newName < legacyIndex && legacyIndex < finalIndex);

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
  const activeRead = rollbackSql.findIndex((sql) => /SELECT count\(\*\)::bigint AS row_count, max\(id\)::bigint/i.test(sql));
  assert.ok(rollbackLock >= 0 && rollbackLock < activeRead && activeRead < archivedNew && archivedNew < restoreLegacy);
});

test("cada comando usa advisory lock de sessao e transacoes usam lock transacional no mesmo client", async () => {
  const db = routedDb((sql, params) => {
    if (/kind = \$1 AND status = 'completed'/i.test(sql)) return { rows: [approvedPreflight()] };
    if (/SELECT min\(created_at\)/i.test(sql)) return { rows: [{ min_created_at: null }] };
    if (/pg_total_relation_size/i.test(sql)) return { rows: [{ relkind: "r" }] };
    if (/partition_operations ORDER BY/i.test(sql)) return { rows: [] };
    return { rows: [] };
  });
  const cutover = createAuthAuditPartitionCutover({ db, env: { AUTH_AUDIT_PARTITION_CONFIRM: "SWAP" } });
  await cutover.status();
  await cutover.copy({ dryRun: true });
  const sql = db.calls.map((call) => call.sql.replace(/\s+/g, " ").trim());
  const sessionLocks = sql.filter((statement) => /pg_advisory_lock\(hashtext/i.test(statement));
  const sessionUnlocks = sql.filter((statement) => /pg_advisory_unlock\(hashtext/i.test(statement));
  assert.equal(sessionLocks.length, 2);
  assert.equal(sessionUnlocks.length, 2);
  assert.ok(sql.findIndex((statement) => /pg_advisory_lock\(hashtext/i.test(statement)) < sql.findIndex((statement) => /pg_total_relation_size/i.test(statement)));
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
  assert.match(sql, /LOCK TABLE/i);
  assert.doesNotMatch(sql, /RENAME TO auth_audit_partitioned_failed/i);
  assert.ok(db.calls.some((call) => /INSERT INTO ml\.auth_audit_partition_operations/i.test(call.sql) && call.params?.[2] === "skipped"));
});

test("rollback bloqueia marker ausente, mas permite o caminho de risco somente com flag literal", async () => {
  const route = (sql, params) => {
    if (/kind = \$1 AND status = 'completed'/i.test(sql)) {
      if (params?.[0] === "swap") return { rows: [] };
      return { rows: [approvedPreflight()] };
    }
    if (/relation\.relname ~ '\^auth_audit_legacy/i.test(sql)) return { rows: [{ relname: "auth_audit_legacy_000000000099" }] };
    if (/to_regclass\(\$1\)/i.test(sql)) return { rows: [{ exists: true }] };
    if (/row_count, max\(id\)/i.test(sql)) return { rows: [{ row_count: "2", max_id: "12", max_created_at: "2026-01-01" }] };
    return { rows: [] };
  };
  const refusedDb = routedDb(route);
  await assert.rejects(
    () => createAuthAuditPartitionCutover({ db: refusedDb, env: { AUTH_AUDIT_PARTITION_CONFIRM: "ROLLBACK" } }).rollback(),
    /marker do swap ausente ou ambiguo/i,
  );
  assert.ok(refusedDb.calls.some((call) => call.params?.[2] === "skipped"));

  const allowedDb = routedDb(route);
  await createAuthAuditPartitionCutover({
    db: allowedDb,
    env: { AUTH_AUDIT_PARTITION_CONFIRM: "ROLLBACK", AUTH_AUDIT_PARTITION_ALLOW_DATA_LOSS: "YES" },
  }).rollback();
  assert.ok(allowedDb.calls.some((call) => /RENAME TO auth_audit_partitioned_failed/i.test(call.sql)));
});

test("release da legacy exige confirmacao literal, preflight novo e observacao completa de 48 horas", async () => {
  const db = routedDb((sql, params) => {
    if (/kind = \$1 AND status = 'completed'/i.test(sql)) {
      if (params?.[0] === "preflight") return { rows: [{ ...approvedPreflight("release_legacy"), completed_at: "2026-09-22T00:00:00.000Z" }] };
      if (params?.[0] === "swap") return { rows: [{ operation_id: "swap-ok", completed_at: "2026-09-21T12:00:00.000Z", details: { legacyName: "auth_audit_legacy_000000000099" } }] };
    }
    if (/to_regclass\(\$1\)/i.test(sql)) return { rows: [{ exists: true }] };
    return { rows: [] };
  });

  const noConfirm = createAuthAuditPartitionCutover({ db, clock: () => new Date("2026-09-23T13:00:00.000Z") });
  await assert.rejects(() => noConfirm.releaseLegacy(), /AUTH_AUDIT_PARTITION_CONFIRM=RELEASE_LEGACY/i);

  const tooEarly = createAuthAuditPartitionCutover({
    db,
    env: { AUTH_AUDIT_PARTITION_CONFIRM: "RELEASE_LEGACY" },
    clock: () => new Date("2026-09-23T11:59:59.000Z"),
  });
  await assert.rejects(() => tooEarly.releaseLegacy(), /48 horas/i);
  assert.doesNotMatch(db.calls.map((call) => call.sql).join("\n"), /DROP TABLE/i);
});

test("release da legacy faz drop somente sob lock apos 48 horas e preflight posterior ao swap", async () => {
  const db = routedDb((sql, params) => {
    if (/kind = \$1 AND status = 'completed'/i.test(sql)) {
      if (params?.[0] === "preflight") return { rows: [{ ...approvedPreflight("release_legacy"), completed_at: "2026-09-23T12:30:00.000Z" }] };
      if (params?.[0] === "swap") return { rows: [{ operation_id: "swap-ok", completed_at: "2026-09-21T12:00:00.000Z", details: { legacyName: "auth_audit_legacy_000000000099" } }] };
    }
    if (/to_regclass\(\$1\)/i.test(sql)) return { rows: [{ exists: true }] };
    if (/relation\.relname = \$2/i.test(sql)) return { rows: [{ relkind: "p" }] };
    return { rows: [] };
  });
  const cutover = createAuthAuditPartitionCutover({
    db,
    env: { AUTH_AUDIT_PARTITION_CONFIRM: "RELEASE_LEGACY" },
    clock: () => new Date("2026-09-23T13:00:00.000Z"),
    randomUUID: () => "00000000-0000-4000-8000-000000000777",
  });

  const dryRun = await cutover.releaseLegacy({ dryRun: true });
  assert.equal(dryRun.dryRun, true);
  assert.doesNotMatch(db.calls.map((call) => call.sql).join("\n"), /DROP TABLE/i);

  const result = await cutover.releaseLegacy();
  const sql = db.calls.map((call) => call.sql).join("\n");
  assert.equal(result.legacyName, "auth_audit_legacy_000000000099");
  assert.match(sql, /LOCK TABLE ml\.auth_audit, ml\.auth_audit_legacy_000000000099 IN ACCESS EXCLUSIVE MODE/i);
  assert.match(sql, /DROP TABLE ml\.auth_audit_legacy_000000000099/i);
  assert.ok(db.calls.some((call) => /auth_audit_partition_operations/i.test(call.sql) && call.params?.[1] === "maintenance"));
});

test("release ignora preflight normal e exige preflight release posterior ao swap", async () => {
  const db = routedDb((sql, params) => {
    if (/kind = \$1 AND status = 'completed'/i.test(sql)) {
      if (params?.[0] === "preflight") return { rows: [{ ...approvedPreflight("cutover"), completed_at: "2026-09-23T12:30:00.000Z" }] };
      if (params?.[0] === "swap") return { rows: [{ operation_id: "swap-ok", completed_at: "2026-09-21T12:00:00.000Z", details: { legacyName: "auth_audit_legacy_000000000099" } }] };
    }
    return { rows: [] };
  });
  const cutover = createAuthAuditPartitionCutover({
    db,
    env: { AUTH_AUDIT_PARTITION_CONFIRM: "RELEASE_LEGACY" },
    clock: () => new Date("2026-09-23T13:00:00.000Z"),
  });

  await assert.rejects(() => cutover.releaseLegacy({ dryRun: true }), /preflight release/i);
});

test("preflight release valida parent particionado, legacy e ledger com modo inequivoco", async () => {
  const db = routedDb((sql, params) => {
    if (/kind = \$1 AND status = 'completed'/i.test(sql) && params?.[0] === "swap") {
      return { rows: [{ operation_id: "swap-ok", completed_at: "2026-09-20T12:00:00.000Z", details: { legacyName: "auth_audit_legacy_000000000099" } }] };
    }
    if (/pg_total_relation_size/i.test(sql) && params?.[1] === "auth_audit") return { rows: [{ relkind: "p", bytes: "2048", row_count: "3", min_created_at: "2026-01-01", max_created_at: "2026-02-01" }] };
    if (/pg_total_relation_size/i.test(sql) && /legacy_000000000099/.test(params?.[1] || "")) return { rows: [{ relkind: "r", bytes: "2048", row_count: "3", min_created_at: "2026-01-01", max_created_at: "2026-02-01" }] };
    if (/to_regclass\('ml\.auth_audit_partition_operations'\)/i.test(sql)) return { rows: [{ exists: true }] };
    if (/current_setting\('data_directory'/i.test(sql)) return { rows: [{ data_directory: "/var/lib/postgresql/data" }] };
    if (/pg_catalog\.pg_attribute/i.test(sql)) return { rows: expectedColumns() };
    if (/source_relation/i.test(sql)) return { rows: [] };
    if (/constraint_row\.contype = 'f'/i.test(sql)) return { rows: expectedForeignKeys() };
    if (/role_table_grants/i.test(sql)) return { rows: [] };
    return { rows: [] };
  });
  const cutover = createAuthAuditPartitionCutover({
    db,
    clock: () => new Date("2026-09-23T13:00:00.000Z"),
    diskInspector: async () => ({ availableBytes: 999999999, source: "test" }),
  });
  const result = await cutover.preflight({
    releaseLegacy: true,
    operationalApproval: { backupRestored: true, maintenanceWindow: true, capacityConfirmed: true },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "release_legacy");
  assert.equal(result.legacyName, "auth_audit_legacy_000000000099");
  assert.ok(db.calls.some((call) => /auth_audit_partition_operations/i.test(call.sql) && JSON.parse(call.params?.[3] || "{}").mode === "release_legacy"));
});

test("release legacy e aceito pelo parser do CLI", () => {
  assert.deepEqual(parseArgs(["release-legacy", "--dry-run"]), { command: "release-legacy", dryRun: true, releaseLegacy: false, batchSize: undefined });
  assert.deepEqual(parseArgs(["preflight", "--release-legacy"]), { command: "preflight", dryRun: false, releaseLegacy: true, batchSize: undefined });
});
