"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const migrationPath = path.join(
  __dirname,
  "..",
  "db",
  "072_auth_audit_partition_operations.sql"
);

test("migration 072 cria ledger idempotente para operações de particionamento", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /create table if not exists ml\.auth_audit_partition_operations/i);
  assert.match(sql, /id\s+bigserial\s+primary key/i);
  assert.match(sql, /operation_id\s+uuid\s+not null\s+unique/i);
  assert.match(sql, /kind\s+text\s+not null/i);
  assert.match(sql, /check\s*\(\s*kind\s+in\s*\(\s*'preflight'\s*,\s*'copy'\s*,\s*'validate'\s*,\s*'swap'\s*,\s*'rollback'\s*,\s*'maintenance'\s*\)\s*\)/i);
  assert.match(sql, /status\s+text\s+not null/i);
  assert.match(sql, /check\s*\(\s*status\s+in\s*\(\s*'started'\s*,\s*'completed'\s*,\s*'failed'\s*,\s*'skipped'\s*\)\s*\)/i);
  assert.match(sql, /details\s+jsonb\s+not null\s+default\s+'\{\}'::jsonb/i);
  assert.match(sql, /started_at\s+timestamptz\s+not null\s+default\s+now\(\)/i);
  assert.match(sql, /completed_at\s+timestamptz/i);
  assert.match(sql, /created_at\s+timestamptz\s+not null\s+default\s+now\(\)/i);
  assert.match(sql, /create index if not exists auth_audit_partition_operations_created_at_idx\s+on ml\.auth_audit_partition_operations\s*\(\s*created_at desc\s*\)/i);
});

test("migration 072 não reescreve, apaga ou referencia a tabela ativa de auditoria", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.doesNotMatch(sql, /delete\s+from\s+ml\.auth_audit\b/i);
  assert.doesNotMatch(sql, /alter\s+table\s+ml\.auth_audit\b/i);
  assert.doesNotMatch(sql, /create\s+table(?:\s+if\s+not\s+exists)?\s+ml\.auth_audit\b/i);
  assert.doesNotMatch(sql, /references\s+ml\.auth_audit\b/i);
  assert.doesNotMatch(sql, /\bbegin\b/i);
  assert.doesNotMatch(sql, /\bcommit\b/i);
  assert.doesNotMatch(sql, /auth_audit_retention_rules\b/i);
});
