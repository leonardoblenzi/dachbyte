"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const migrationPath = path.join(
  __dirname,
  "..",
  "db",
  "071_add_company_deletion_audit_scope.sql"
);

function migrationSql() {
  return fs.readFileSync(migrationPath, "utf8");
}

test("migration 071 cria escopo relacional para auditoria de empresa e conta ML", () => {
  const sql = migrationSql();

  assert.match(sql, /alter table ml\.auth_audit[\s\S]*add column if not exists empresa_id bigint/i);
  assert.match(sql, /alter table ml\.auth_audit[\s\S]*add column if not exists meli_conta_id bigint/i);
  assert.match(sql, /auth_audit_empresa_id_fkey/i);
  assert.match(sql, /foreign key \(empresa_id\)[\s\S]*references ml\.empresas\(id\)[\s\S]*on delete cascade/i);
  assert.match(sql, /auth_audit_meli_conta_id_fkey/i);
  assert.match(sql, /foreign key \(meli_conta_id\)[\s\S]*references ml\.meli_contas\(id\)[\s\S]*on delete cascade/i);
  assert.match(sql, /create index if not exists auth_audit_empresa_created_at_idx[\s\S]*\(empresa_id, created_at desc\)/i);
  assert.match(sql, /create index if not exists auth_audit_meli_conta_created_at_idx[\s\S]*\(meli_conta_id, created_at desc\)/i);
  assert.match(sql, /conname = 'auth_audit_empresa_id_fkey'[\s\S]*conrelid = 'ml\.auth_audit'::regclass/i);
  assert.match(sql, /conname = 'auth_audit_meli_conta_id_fkey'[\s\S]*conrelid = 'ml\.auth_audit'::regclass/i);
  assert.match(sql, /c\.contype = 'f'[\s\S]*c\.confrelid = 'ml\.empresas'::regclass[\s\S]*attrelid = 'ml\.empresas'::regclass[\s\S]*attname = 'id'[\s\S]*c\.confdeltype = 'c'/i);
  assert.match(sql, /c\.contype = 'f'[\s\S]*c\.confrelid = 'ml\.meli_contas'::regclass[\s\S]*attrelid = 'ml\.meli_contas'::regclass[\s\S]*attname = 'id'[\s\S]*c\.confdeltype = 'c'/i);
  assert.match(sql, /attname = 'empresa_id'[\s\S]*drop constraint auth_audit_empresa_id_fkey/i);
  assert.match(sql, /attname = 'meli_conta_id'[\s\S]*drop constraint auth_audit_meli_conta_id_fkey/i);
});

test("migration 071 deixa a transação para o migration runner", () => {
  const sql = migrationSql();

  assert.doesNotMatch(sql, /^BEGIN;\s*$/im);
  assert.doesNotMatch(sql, /^COMMIT;\s*$/im);
  assert.match(sql, /janela de manutenção após backup/i);
});

test("migration 071 faz backfill seguro e dá precedência à empresa da conta ML", () => {
  const sql = migrationSql();

  assert.match(sql, /metadata\s*->>\s*'meli_conta_id'\s*~\s*'\^\[0-9\]\+\$'/i);
  assert.match(sql, /metadata\s*->>\s*'empresa_id'\s*~\s*'\^\[0-9\]\+\$'/i);
  assert.match(sql, /metadata\s*->>\s*'company_id'\s*~\s*'\^\[0-9\]\+\$'/i);
  assert.match(sql, /from valid_values v[\s\S]*join ml\.meli_contas mc on mc\.id = v\.meli_conta_id/i);
  assert.match(sql, /empresa_id\s*=\s*mc\.empresa_id/i);
  assert.match(sql, /where a\.meli_conta_id is not null/i);
  assert.match(sql, /coalesce\(nullif\(ltrim\(a\.metadata\s*->>\s*'meli_conta_id', '0'\), ''\), '0'\)/i);
  assert.match(sql, /char_length\(meli_conta_digits\) < 19[\s\S]*meli_conta_digits <= '9223372036854775807'[\s\S]*then meli_conta_digits::bigint/i);
  assert.match(sql, /char_length\(empresa_digits\) < 19[\s\S]*empresa_digits <= '9223372036854775807'[\s\S]*then empresa_digits::bigint/i);
  assert.match(sql, /char_length\(company_digits\) < 19[\s\S]*company_digits <= '9223372036854775807'[\s\S]*then company_digits::bigint/i);
  assert.doesNotMatch(sql, /\(a\.metadata\s*->>\s*'(?:meli_conta_id|empresa_id|company_id)'\)::bigint/i);
});

test("migration 071 guarda recibo mínimo de exclusão sem campos sensíveis", () => {
  const sql = migrationSql();
  const receiptStart = sql.search(/create table if not exists ml\.company_deletion_receipts/i);

  assert.ok(receiptStart >= 0, "deve criar company_deletion_receipts");
  const receiptSql = sql.slice(receiptStart);
  for (const column of [
    "id bigserial primary key",
    "request_id uuid not null unique",
    "deleted_empresa_id bigint not null",
    "empresa_nome",
    "actor_user_id bigint",
    "actor_email text",
    "deleted_at timestamptz not null default now()",
    "users_deleted_count integer not null default 0",
    "users_unlinked_count integer not null default 0",
    "accounts_deleted_count integer not null default 0",
    "audit_events_deleted_count bigint not null default 0",
    "status text not null default 'completed'",
  ]) {
    assert.match(receiptSql, new RegExp(column.replace(/[()]/g, "\\$&"), "i"));
  }

  assert.match(receiptSql, /check \(users_deleted_count >= 0\)/i);
  assert.match(receiptSql, /check \(audit_events_deleted_count >= 0\)/i);
  assert.match(receiptSql, /check \(status in \('completed', 'failed'\)\)/i);
  assert.doesNotMatch(receiptSql, /\b(token|ip|user_agent|metadata)\b/i);
  assert.doesNotMatch(receiptSql, /foreign key \(deleted_empresa_id\)/i);
});
