"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL ||= "postgresql://audit-test:audit-test@127.0.0.1:5432/audit-test";

const db = require("../db/db");
const { recordAuthEvent } = require("../services/authAuditService");

async function captureAuditInsert(t, input) {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [] };
  };
  t.after(() => {
    db.query = originalQuery;
  });

  await recordAuthEvent({ evento: "scope_test", ...input });
  assert.equal(calls.length, 1);
  return calls[0];
}

test("records an explicit account after resolving its company in the database", async (t) => {
  const call = await captureAuditInsert(t, { meliContaId: "42", empresaId: "9" });

  assert.match(call.sql, /from ml\.meli_contas/i);
  assert.match(call.sql, /from ml\.empresas/i);
  assert.match(call.sql, /empresa_id,\s*meli_conta_id/i);
  assert.equal(call.params.at(-2), "42");
  assert.equal(call.params.at(-1), "9");
});

test("derives the account candidate from metadata accountKey", async (t) => {
  const call = await captureAuditInsert(t, { metadata: { accountKey: "77" } });

  assert.equal(call.params.at(-2), "77");
  assert.equal(call.params.at(-1), null);
});

test("records an explicit company when no account is supplied", async (t) => {
  const call = await captureAuditInsert(t, { empresaId: "15" });

  assert.equal(call.params.at(-2), null);
  assert.equal(call.params.at(-1), "15");
});

test("keeps the account candidate separate from a conflicting company candidate", async (t) => {
  const call = await captureAuditInsert(t, { meliContaId: "42", empresaId: "9" });

  assert.match(call.sql, /coalesce\s*\(\s*\(select empresa_id from resolved_account\)/i);
  assert.equal(call.params.at(-2), "42");
  assert.equal(call.params.at(-1), "9");
});

test("ignores malformed and unsafe bigint candidates without casting them", async (t) => {
  const call = await captureAuditInsert(t, {
    meliContaId: "9223372036854775808",
    empresaId: "15; select 1",
    metadata: { accountKey: "not-a-number", company_id: "99999999999999999999999" },
  });

  assert.equal(call.params.at(-2), null);
  assert.equal(call.params.at(-1), null);
  assert.doesNotMatch(call.sql, /metadata\s*->>.*::bigint/i);
});

test("keeps audit recording best-effort when the audit database is unavailable", async (t) => {
  const originalQuery = db.query;
  const originalError = console.error;
  const errors = [];
  db.query = async () => {
    throw new Error("audit unavailable");
  };
  console.error = (...args) => errors.push(args);
  t.after(() => {
    db.query = originalQuery;
    console.error = originalError;
  });

  await assert.doesNotReject(() => recordAuthEvent({ evento: "scope_test" }));
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /auditoria/i);
});
