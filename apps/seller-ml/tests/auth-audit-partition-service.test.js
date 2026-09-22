const assert = require("node:assert/strict");
const test = require("node:test");

const {
  monthBoundsUtc,
  partitionNameForMonth,
  createAuthAuditPartitionService,
} = require("../services/authAuditPartitionService");

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
  };
}

function partitionedInspection() {
  return { rows: [{ relkind: "p", partition_key: "RANGE (created_at)" }] };
}

test("calcula limites mensais UTC e nomes de particao sem depender do fuso local", () => {
  const bounds = monthBoundsUtc(new Date("2026-09-22T23:59:59-03:00"));
  assert.equal(bounds.from.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(bounds.to.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(partitionNameForMonth(bounds.from), "auth_audit_2026_09");
});

test("inspeciona o catalogo e somente aceita parent particionada por created_at", async () => {
  const db = queryDb([partitionedInspection()]);
  const service = createAuthAuditPartitionService({ db });
  const result = await service.inspectCurrentTable();

  assert.equal(result.partitioned, true);
  assert.match(db.calls[0].sql, /pg_catalog\.pg_class/i);
  assert.match(db.calls[0].sql, /pg_get_partkeydef/i);
  assert.deepEqual(db.calls[0].params, ["ml", "auth_audit"]);
});

test("recusa mutacoes antes do cutover quando auth_audit nao e parent particionada", async () => {
  const db = queryDb([{ rows: [{ relkind: "r", partition_key: null }] }]);
  const service = createAuthAuditPartitionService({ db });

  const result = await service.ensurePartitions();
  assert.equal(result.applied, false);
  assert.equal(db.calls.length, 1);
});

test("cria default e ranges UTC idempotentes, apenas com identificadores gerados", async () => {
  const db = queryDb([partitionedInspection(), { rows: [] }, { rows: [] }, { rows: [] }]);
  const service = createAuthAuditPartitionService({
    db,
    clock: () => new Date("2026-09-22T12:00:00.000Z"),
    monthsAhead: 1,
  });

  const result = await service.ensurePartitions();
  const sql = db.calls.slice(1).map((call) => call.sql).join("\n");
  assert.equal(result.applied, true);
  assert.deepEqual(result.partitions, ["auth_audit_2026_09", "auth_audit_2026_10"]);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ml\.auth_audit_default/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ml\.auth_audit_2026_09/i);
  assert.match(sql, /FOR VALUES FROM \('2026-09-01T00:00:00\.000Z'\) TO \('2026-10-01T00:00:00\.000Z'\)/);
  assert.doesNotMatch(sql, /auth_audit_.*;.*DROP/i);
});

test("drena a default por batch para o parent sem apagar eventos isoladamente", async () => {
  const db = queryDb([
    partitionedInspection(),
    { rows: [{ relname: "auth_audit_default", bound: "DEFAULT" }] },
    { rows: [{ month_start: new Date("2026-09-01T00:00:00.000Z"), row_count: "2" }] },
    { rows: [] },
    { rows: [{ moved_count: "2" }] },
    { rows: [] },
  ]);
  const service = createAuthAuditPartitionService({ db });
  const result = await service.drainDefaultPartition({ batchSize: 50 });
  const sql = db.calls.map((call) => call.sql).join("\n");

  assert.equal(result.moved, 2);
  assert.match(sql, /DELETE FROM ml\.auth_audit_default/i);
  assert.match(sql, /INSERT INTO ml\.auth_audit SELECT \* FROM moved/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ml\.auth_audit_2026_09/i);
});

test("limpa retencao antes de avaliar particoes e so derruba apos confirmacao", async () => {
  const cleanupCalls = [];
  const baseResponses = () => [
    partitionedInspection(),
    { rows: [
      { relname: "auth_audit_2026_06", bound: "FOR VALUES FROM ('2026-06-01') TO ('2026-07-01')" },
      { relname: "auth_audit_default", bound: "DEFAULT" },
      { relname: "unexpected;drop", bound: "FOR VALUES FROM ('2025-01-01') TO ('2025-02-01')" },
    ] },
    { rows: [{ safe_to_drop: true }] },
  ];
  const dryDb = queryDb(baseResponses());
  const dryService = createAuthAuditPartitionService({
    db: dryDb,
    clock: () => new Date("2026-09-22T12:00:00.000Z"),
    cleanupAuthAudit: async () => cleanupCalls.push("cleanup"),
  });
  const dry = await dryService.pruneExpiredPartitions();
  assert.deepEqual(cleanupCalls, ["cleanup"]);
  assert.deepEqual(dry.eligible, ["auth_audit_2026_06"]);
  assert.deepEqual(dry.dropped, []);
  assert.doesNotMatch(dryDb.calls.map((call) => call.sql).join("\n"), /DROP TABLE/i);

  const confirmDb = queryDb(baseResponses());
  const confirmService = createAuthAuditPartitionService({
    db: confirmDb,
    clock: () => new Date("2026-09-22T12:00:00.000Z"),
    cleanupAuthAudit: async () => {},
  });
  const confirmed = await confirmService.pruneExpiredPartitions({ confirmDrop: true });
  assert.deepEqual(confirmed.dropped, ["auth_audit_2026_06"]);
  const confirmSql = confirmDb.calls.map((call) => call.sql).join("\n");
  assert.match(confirmSql, /DETACH PARTITION ml\.auth_audit_2026_06/i);
  assert.match(confirmSql, /DROP TABLE IF EXISTS ml\.auth_audit_2026_06/i);
  assert.doesNotMatch(confirmSql, /unexpected;drop/);
});

test("verifica parent, particoes e linhas restantes na default sem assumir transicao", async () => {
  const db = queryDb([
    { rows: [{ relkind: "r", partition_key: null }] },
    { rows: [{ relname: "auth_audit_default", bound: "DEFAULT" }] },
    { rows: [{ row_count: "3" }] },
  ]);
  const service = createAuthAuditPartitionService({ db });
  const result = await service.verifyPartitionedAudit();
  assert.equal(result.parent.partitioned, false);
  assert.equal(result.defaultRows, 3);
  assert.equal(result.defaultPresent, true);
});

test("registra e atualiza operacao no ledger com UUID e detalhes", async () => {
  const db = queryDb([{ rows: [{ operation_id: "00000000-0000-4000-8000-000000000001", status: "completed" }] }]);
  const service = createAuthAuditPartitionService({ db, randomUUID: () => "00000000-0000-4000-8000-000000000001" });
  const result = await service.recordOperation({ kind: "maintenance", status: "completed", details: { moved: 2 } });
  assert.equal(result.operationId, "00000000-0000-4000-8000-000000000001");
  assert.match(db.calls[0].sql, /ON CONFLICT \(operation_id\) DO UPDATE/i);
  assert.equal(db.calls[0].params[3], JSON.stringify({ moved: 2 }));
});
