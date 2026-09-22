"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../../..");
const opsPath = path.join(root, "infra", "business-db-ops.sh");
const runbookPath = path.join(root, "docs", "operations", "ml-auth-audit-partition-cutover.md");

test("partition cutover remains explicit and protected in VPS operations", () => {
  const ops = fs.readFileSync(opsPath, "utf8");

  for (const command of ["status", "preflight", "copy", "verify", "swap", "rollback", "release-legacy"]) {
    assert.match(ops, new RegExp(`audit-partition-${command}`));
    assert.match(ops, new RegExp(`run_audit_partition_cutover ${command}`));
  }

  assert.match(ops, /authAuditPartitionCutover\.js "\$action"/);
  assert.match(ops, /require_confirmation COPY/);
  assert.match(ops, /require_confirmation SWAP/);
  assert.match(ops, /require_confirmation ROLLBACK/);
  assert.match(ops, /require_confirmation RELEASE_LEGACY/);
  assert.match(ops, /AUTH_AUDIT_PARTITION_ALLOW_DATA_LOSS=YES/);
  assert.match(ops, /--dry-run/);
  assert.match(ops, /AUTH_AUDIT_PARTITION_BACKUP_RESTORED/);
  assert.match(ops, /AUTH_AUDIT_PARTITION_MAINTENANCE_WINDOW/);
  assert.match(ops, /AUTH_AUDIT_PARTITION_AVAILABLE_BYTES/);
  assert.match(ops, /AUTH_AUDIT_PARTITION_DISK_PATH/);
  assert.match(ops, /cutover_env_args\+=\(-e "\$name"\)/);
  assert.doesNotMatch(ops, /env\s*\|/i);
  const provisionBlock = ops.match(/  provision\)[\s\S]*?    ;;/)?.[0] || "";
  const migrateBlock = ops.match(/  migrate\)[\s\S]*?    ;;/)?.[0] || "";
  assert.doesNotMatch(provisionBlock, /audit-partition/);
  assert.doesNotMatch(migrateBlock, /audit-partition/);
});

test("cutover runbook has operational gates and safe legacy handling", () => {
  const runbook = fs.readFileSync(runbookPath, "utf8");

  for (const term of [
    "Restic", "restore", "janela", "espaço", "preflight", "copy", "verify", "swap",
    "48", "rollback", "AUTH_AUDIT_PARTITION_CONFIRM=SWAP", "AUTH_AUDIT_PARTITION_CONFIRM=ROLLBACK",
    "AUTH_AUDIT_PARTITION_ALLOW_DATA_LOSS=YES", "auth_audit_retention_rules", "--dry-run", "release-legacy",
    "AUTH_AUDIT_PARTITION_CONFIRM=RELEASE_LEGACY",
  ]) {
    assert.match(runbook, new RegExp(term, "i"));
  }

  assert.match(runbook, /docker compose down/i);
  assert.match(runbook, /VACUUM FULL/i);
  assert.match(runbook, /backup fresco/i);
  assert.match(runbook, /preflight novo/i);
});
