const assert = require("node:assert/strict");
const test = require("node:test");

const { createCompanyDeletionService } = require("../services/companyDeletionService");

function queryResult(rows = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function createDb(respond) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      return respond(String(sql), params, calls);
    },
  };
  return {
    calls,
    withClient: async (fn) => fn(client),
    query: (sql, params = []) => client.query(sql, params),
  };
}

test("preview contabiliza auditoria por escopo relacional, metadata e usuario", async () => {
  const db = createDb((sql) => {
    if (/from ml\.empresas/i.test(sql)) return queryResult([{ id: 7, nome: "Mpozenato" }]);
    if (/from ml\.empresa_usuarios/i.test(sql)) {
      return queryResult([
        { id: 11, nome: "Exclusivo", email: "only@example.com", nivel: "operador", empresas_count: 1 },
        { id: 12, nome: "Compartilhado", email: "shared@example.com", nivel: "operador", empresas_count: 2 },
        { id: 13, nome: "Master", email: "master@example.com", nivel: "admin_master", empresas_count: 1 },
      ]);
    }
    if (/from ml\.meli_contas/i.test(sql)) return queryResult([{ id: 21, apelido: "Conta A", meli_user_id: "123" }]);
    if (/count\(\*\).*ml\.auth_audit/is.test(sql)) return queryResult([{ count: "9" }]);
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const activeJobs = { checkCompanyActiveJobs: async (keys) => {
    assert.deepEqual(keys, ["21", "123"]);
    return { blocked: false, activeJobs: [], inspectionFailures: [] };
  } };
  const service = createCompanyDeletionService({ db, activeJobs, randomUUID: () => "00000000-0000-4000-8000-000000000001" });

  const preview = await service.previewCompanyDeletion(7);

  assert.equal(preview.empresa.nome, "Mpozenato");
  assert.deepEqual(preview.usersToDelete.map((user) => user.id), [11]);
  assert.deepEqual(preview.usersToUnlink.map((user) => user.id), [12, 13]);
  assert.equal(preview.accounts.length, 1);
  assert.equal(preview.auditEventsCount, 9);
  assert.equal(preview.blocked, false);
  assert.equal(preview.canDelete, true);
  const auditQuery = db.calls.find((call) => /ml\.auth_audit/i.test(call.sql));
  assert.match(auditQuery.sql, /a\.empresa_id = \$1/i);
  assert.match(auditQuery.sql, /a\.meli_conta_id = any\(\$2::bigint\[\]\)/i);
  assert.match(auditQuery.sql, /a\.user_id = any\(\$4::bigint\[\]\)/i);
  assert.deepEqual(auditQuery.params, [7, [21], ["21", "123"], [11]]);
});

function deletionResponder({ blocked = false, receiptFailure = false } = {}) {
  return (sql) => {
    if (/^begin$|^commit$|^rollback$/i.test(sql.trim())) return queryResult();
    if (/from ml\.empresas/i.test(sql) && /select/i.test(sql)) return queryResult([{ id: 7, nome: "Empresa" }]);
    if (/from ml\.empresa_usuarios/i.test(sql)) {
      return queryResult([
        { id: 11, nome: "Exclusivo", email: "only@example.com", nivel: "operador", empresas_count: 1 },
        { id: 13, nome: "Master", email: "master@example.com", nivel: "admin_master", empresas_count: 1 },
      ]);
    }
    if (/from ml\.meli_contas/i.test(sql)) return queryResult([{ id: 21, meli_user_id: "123" }]);
    if (/count\(\*\).*ml\.auth_audit/is.test(sql)) return queryResult([{ count: "3" }]);
    if (/select id from ml\.usuarios[\s\S]*for update/i.test(sql)) return queryResult([{ id: 11 }]);
    if (/delete from ml\.auth_audit/i.test(sql)) return queryResult([], 3);
    if (/delete from ml\.usuarios/i.test(sql)) return queryResult([], 1);
    if (/delete from ml\.empresas/i.test(sql)) return queryResult([{ id: 7 }], 1);
    if (/insert into ml\.company_deletion_receipts/i.test(sql)) {
      if (receiptFailure) throw new Error("receipt unavailable");
      return queryResult([{ request_id: "00000000-0000-4000-8000-000000000001", status: "completed" }], 1);
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  };
}

test("delete executa auditoria, usuarios, empresa, recibo e commit nessa ordem", async () => {
  const db = createDb(deletionResponder());
  const service = createCompanyDeletionService({
    db,
    activeJobs: { checkCompanyActiveJobs: async () => ({ blocked: false, activeJobs: [], inspectionFailures: [] }) },
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
  });

  const result = await service.deleteCompany({ companyId: 7, actor: { id: 99, email: "admin@example.com" } });

  assert.equal(result.deletedAuditEvents, 3);
  assert.equal(result.deletedUsers, 1);
  assert.equal(result.deletedCompany, 1);
  assert.equal(result.receipt.status, "completed");
  const mutationOrder = db.calls
    .map((call) => call.sql.replace(/\s+/g, " ").trim().toLowerCase())
    .filter((sql) => /^(delete|insert|commit)/.test(sql));
  assert.deepEqual(mutationOrder.map((sql) => {
    if (sql.startsWith("delete from ml.auth_audit")) return "audit";
    if (sql.startsWith("delete from ml.usuarios")) return "users";
    if (sql.startsWith("delete from ml.empresas")) return "company";
    if (sql.startsWith("insert into ml.company_deletion_receipts")) return "receipt";
    return "commit";
  }), ["audit", "users", "company", "receipt", "commit"]);
  const lockIndex = db.calls.findIndex((call) => /select id from ml\.usuarios[\s\S]*for update/i.test(call.sql));
  const auditDeleteIndex = db.calls.findIndex((call) => /delete from ml\.auth_audit/i.test(call.sql));
  assert.ok(lockIndex >= 0, "deve travar usuários exclusivos antes da limpeza de auditoria");
  assert.ok(lockIndex < auditDeleteIndex, "o lock de usuários deve preceder DELETE auth_audit");
  assert.deepEqual(db.calls[lockIndex].params, [[11]]);
  const usersDelete = db.calls.find((call) => /delete from ml\.usuarios/i.test(call.sql));
  assert.deepEqual(usersDelete.params, [[11]]);
});

test("delete faz rollback ao reencontrar job ativo no recheck transacional", async () => {
  const db = createDb(deletionResponder());
  const service = createCompanyDeletionService({
    db,
    activeJobs: { checkCompanyActiveJobs: async () => ({ blocked: true, activeJobs: [{ jobId: "x" }], inspectionFailures: [] }) },
  });

  await assert.rejects(
    () => service.deleteCompany({ companyId: 7 }),
    (error) => error.code === "COMPANY_DELETION_BLOCKED",
  );
  assert.equal(db.calls.some((call) => /delete from ml\.auth_audit/i.test(call.sql)), false);
  assert.equal(db.calls.some((call) => /^rollback$/i.test(call.sql.trim())), true);
});

test("delete faz rollback se o recibo falhar depois da exclusao", async () => {
  const db = createDb(deletionResponder({ receiptFailure: true }));
  const service = createCompanyDeletionService({
    db,
    activeJobs: { checkCompanyActiveJobs: async () => ({ blocked: false, activeJobs: [], inspectionFailures: [] }) },
  });

  await assert.rejects(() => service.deleteCompany({ companyId: 7 }), /receipt unavailable/);
  assert.equal(db.calls.some((call) => /^commit$/i.test(call.sql.trim())), false);
  assert.equal(db.calls.some((call) => /^rollback$/i.test(call.sql.trim())), true);
});

test("lista recibos com filtros parametrizados e paginação limitada", async () => {
  const db = createDb((sql, params) => {
    if (/select count\(\*\).*company_deletion_receipts/is.test(sql)) return queryResult([{ total: "1" }]);
    if (/from ml\.company_deletion_receipts/i.test(sql)) return queryResult([{ id: 1, empresa_nome: "Empresa" }]);
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const service = createCompanyDeletionService({ db, activeJobs: { checkCompanyActiveJobs: async () => ({}) } });

  const result = await service.listDeletionReceipts({ search: "Empresa", from: "2026-01-01", to: "2026-12-31", operator: "admin@example.com", page: 2, pageSize: 1000 });

  assert.equal(result.page, 2);
  assert.equal(result.pageSize, 100);
  assert.equal(result.total, 1);
  const countCall = db.calls.find((call) => /select count\(\*\).*company_deletion_receipts/is.test(call.sql));
  assert.equal(countCall.sql.includes("?"), false);
  assert.match(countCall.sql, /\$1/);
  assert.deepEqual(countCall.params, ["%Empresa%", "%Empresa%", "2026-01-01", "2026-12-31", "admin@example.com", "admin@example.com"]);
});
