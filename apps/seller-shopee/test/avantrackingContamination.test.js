"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  AVANTRACKING_ONLY_TABLES,
  CANONICAL_SHOPEE_USER_FK_TUPLES,
  KNOWN_CONTAMINATED_FKS,
  MISPLACED_MIGRATIONS,
  QUARANTINE_SCHEMA,
  SHARED_CONTAMINATED_COLUMNS,
  buildRepairPlan,
  executeRepair,
  inspectContamination,
  inspectCurrentRepairState,
  inspectRepairState,
  validatePreflight,
} = require("../scripts/lib/avantrackingContamination");
const {
  buildDryRunSummary,
  loadAvantrackingDatabaseUrl,
  resolveSslOptions,
  runPreflight,
} = require("../scripts/repair-avantracking-contamination");

const EXPECTED_MIGRATIONS = [
  "20260423150000_bootstrap_sql_runner",
  "20260424120000_user_profile_settings",
  "20260424130000_ensure_company_multitenancy_base",
  "20260424154000_company_auto_sync_statuses",
  "20260424170000_ensure_tray_integration_tables",
  "20260424180000_ensure_user_auth_schema",
  "20260424190000_normalize_user_ids_as_text",
  "20260424200000_relax_legacy_user_required_columns",
  "20260424210000_ensure_order_and_notifications_schema",
  "20260424211000_ensure_related_tables_schema",
  "20260424213000_repair_order_and_notification_schema",
];

test("identity compatibility migration builds valid sequence regclass names", () => {
  const migrationSql = fs.readFileSync(path.join(
    __dirname,
    "..",
    "db",
    "migrations",
    "20260424230000_ensure_numeric_identity_compatibility",
    "migration.sql",
  ), "utf8");

  assert.doesNotMatch(migrationSql, /seq_name\s*:=\s*format\('%I_id_seq',\s*t_name\)/);
  assert.match(migrationSql, /seq_name\s*:=\s*t_name\s*\|\|\s*'_id_seq'/);
  assert.match(
    migrationSql,
    /ALTER TABLE %I ALTER COLUMN id SET DEFAULT nextval\(%L::regclass\)'[\s\S]*t_name,[\s\S]*format\('%I',\s*seq_name\)/,
  );
  assert.match(
    migrationSql,
    /SELECT setval\(%L::regclass,[\s\S]*format\('%I',\s*seq_name\),[\s\S]*t_name/,
  );
});

test("identity compatibility migration repairs orphaned User references", () => {
  const migrationSql = fs.readFileSync(path.join(
    __dirname,
    "..",
    "db",
    "migrations",
    "20260424230000_ensure_numeric_identity_compatibility",
    "migration.sql",
  ), "utf8");

  assert.match(
    migrationSql,
    /DELETE FROM "Session" s[\s\S]*s\."userId" IS NOT NULL[\s\S]*NOT EXISTS \([\s\S]*FROM "User" u[\s\S]*u\."id"::text = s\."userId"::text/,
  );
  for (const [tableName, columnName] of [
    ["Session", "realUserId"],
    ["ListingCloneDraft", "userId"],
    ["ProductBoostBatch", "userId"],
    ["AuthAudit", "userId"],
  ]) {
    assert.match(
      migrationSql,
      new RegExp(`UPDATE "${tableName}"[\\s\\S]*SET "${columnName}" = NULL[\\s\\S]*NOT EXISTS`),
    );
  }
});

test("Shopee SQL migrations do not contain a UTF-8 BOM", () => {
  const migrationsDir = path.join(__dirname, "..", "db", "migrations");
  const filesWithBom = fs.readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(migrationsDir, entry.name, "migration.sql"))
    .filter((filePath) => fs.existsSync(filePath))
    .filter((filePath) => {
      const content = fs.readFileSync(filePath);
      return content.length >= 3
        && content[0] === 0xef
        && content[1] === 0xbb
        && content[2] === 0xbf;
    })
    .map((filePath) => path.relative(migrationsDir, filePath));

  assert.deepEqual(filesWithBom, []);
});

test("price update event migration removes orphaned shop references before adding its foreign key", () => {
  const migrationSql = fs.readFileSync(path.join(
    __dirname,
    "..",
    "db",
    "migrations",
    "20260525110000_add_product_price_update_events",
    "migration.sql",
  ), "utf8");

  const orphanCleanupIndex = migrationSql.indexOf('DELETE FROM "ProductPriceUpdateEvent"');
  const foreignKeyIndex = migrationSql.indexOf('ADD CONSTRAINT "ProductPriceUpdateEvent_shopId_fkey"');

  assert.notEqual(orphanCleanupIndex, -1);
  assert.notEqual(foreignKeyIndex, -1);
  assert.ok(orphanCleanupIndex < foreignKeyIndex);
  assert.match(
    migrationSql,
    /DELETE FROM "ProductPriceUpdateEvent" e[\s\S]*NOT EXISTS \([\s\S]*FROM "Shop" s[\s\S]*s\."id" = e\."shopId"/,
  );
});

const EXPECTED_KNOWN_CONTAMINATED_FKS = [
  ["LogisyncUser_companyId_fkey", "LogisyncUser", "companyId", "Company", "id"],
  ["MonitoredOrder_companyId_fkey", "MonitoredOrder", "companyId", "Company", "id"],
  ["MonitoredOrder_createdById_fkey", "MonitoredOrder", "createdById", "User", "id"],
  ["Order_carrierId_fkey", "Order", "carrierId", "Carrier", "id"],
  ["Order_companyId_fkey", "Order", "companyId", "Company", "id"],
  ["Order_createdById_fkey", "Order", "createdById", "User", "id"],
  ["SyncNotification_companyId_fkey", "SyncNotification", "companyId", "Company", "id"],
  ["TrayAuth_companyId_fkey", "TrayAuth", "companyId", "Company", "id"],
  ["TrayCheckoutQuote_companyIdValue_fkey", "TrayCheckoutQuote", "companyIdValue", "Company", "id"],
  ["TrayCheckoutQuote_companyId_fkey", "TrayCheckoutQuote", "companyId", "Company", "id"],
  ["User_companyId_fkey", "User", "companyId", "Company", "id"],
  ["UserAccessToken_userId_fkey", "UserAccessToken", "userId", "User", "id"],
];

const EXPECTED_CANONICAL_SHOPEE_USER_FKS = [
  ["Session_userId_fkey", "Session", "userId", "User", "id"],
  ["Session_realUserId_fkey", "Session", "realUserId", "User", "id"],
  ["ListingCloneDraft_userId_fkey", "ListingCloneDraft", "userId", "User", "id"],
  ["ProductBoostBatch_userId_fkey", "ProductBoostBatch", "userId", "User", "id"],
  ["AuthAudit_userId_fkey", "AuthAudit", "userId", "User", "id"],
  ["OAuthState_userId_fkey", "OAuthState", "userId", "User", "id"],
];

const WRITE_SQL = /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i;

function validReport() {
  return {
    shopeeTarget: { fingerprint: "271508fcaaff" },
    avantrackingTarget: { fingerprint: "9d5db7fc1b75" },
    shopeeAppliedMigrations: new Set([...MISPLACED_MIGRATIONS, "canonical-shopee-migration"]),
    avantrackingAppliedMigrations: new Set(MISPLACED_MIGRATIONS),
    activeAvantrackingObjects: [...AVANTRACKING_ONLY_TABLES],
    tableRowCounts: new Map(AVANTRACKING_ONLY_TABLES.map((tableName) => [tableName, 2])),
    criticalColumnTypes: [],
    nonNumericUserIdCount: 0,
    foreignKeys: EXPECTED_KNOWN_CONTAMINATED_FKS.map(([
      constraintName,
      sourceTable,
      sourceColumn,
      targetTable,
      targetColumn,
    ]) => ({
      constraintName,
      sourceTable,
      sourceColumn,
      targetTable,
      targetColumn,
    })),
    avantrackingMigrationSnapshots: MISPLACED_MIGRATIONS.map((name, index) => ({
      name,
      rowData: JSON.stringify({
        name,
        checksum: `checksum-${index}`,
        source: "script",
        applied_at: `2026-08-01T00:${String(index).padStart(2, "0")}:00.000Z`,
        execution_ms: index + 100,
      }),
    })),
  };
}

function repairedReport(manifest) {
  return {
    ...validReport(),
    shopeeAppliedMigrations: new Set(["canonical-shopee-migration"]),
    activeAvantrackingObjects: [],
    tableRowCounts: new Map(),
    foreignKeys: [],
    repairState: { status: "repaired", manifest },
  };
}

function normalizedSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function resealManifest(manifest) {
  delete manifest.evidenceSha256;
  manifest.evidenceSha256 = crypto.createHash("sha256").update(stableJson(manifest)).digest("hex");
}

function initialBehavioralState(plan) {
  const publicTables = {};
  for (const tableName of Object.keys(SHARED_CONTAMINATED_COLUMNS)) {
    const canonical = plan.repairContext.canonicalColumns
      .filter(([candidate]) => candidate === tableName)
      .map(([, columnName]) => columnName);
    const columns = [...new Set([...canonical, ...SHARED_CONTAMINATED_COLUMNS[tableName]])];
    publicTables[tableName] = {
      columns,
      rows: [1, 2, 3].map((id) => Object.fromEntries(columns.map((column) => (
        [column, column === "id" ? id : `${tableName}-${column}-${id}`]
      )))),
    };
  }
  for (const tableName of plan.repairContext.activeAvantrackingObjects) {
    publicTables[tableName] = {
      columns: ["id"],
      rows: [{ id: `${tableName}-1` }, { id: `${tableName}-2` }],
    };
  }

  return {
    publicTables,
    history: [
      ...MISPLACED_MIGRATIONS.map((name, index) => ({
        name,
        checksum: `checksum-${index}`,
        source: "script",
        applied_at: `2026-08-11T00:${String(index).padStart(2, "0")}:00.000Z`,
        execution_ms: index,
      })),
      {
        name: "canonical-shopee-migration",
        checksum: "canonical-checksum",
        source: "script",
        applied_at: "2026-08-10T00:00:00.000Z",
        execution_ms: 5,
      },
    ],
    foreignKeys: plan.find(({ name }) => name === "validate-current-foreign-keys").expectedRows,
    quarantine: null,
  };
}

class StatefulRepairClient {
  constructor(plan) {
    this.plan = plan;
    this.queries = [];
    this.state = initialBehavioralState(plan);
    this.transactionStart = null;
    this.lockedTables = new Set();
    this.advisoryLocked = false;
    this.tamperManifestOnRead = false;
    this.lastObservedSourceInventory = null;
    this.addTableDuringLock = null;
    this.sourceJsonbText = {};
  }

  requireTransaction() {
    assert.ok(this.transactionStart, "mutation outside transaction");
  }

  requireLocked(tableName) {
    assert.ok(this.lockedTables.has(tableName), `source table was not locked: ${tableName}`);
  }

  rowsFor(tableName) {
    return this.state.publicTables[tableName]?.rows || [];
  }

  async inspectCurrentReport() {
    return inspectCurrentRepairState(
      this,
      this.plan.repairContext.avantrackingMigrationSnapshots,
    );
  }

  async query(sql, params = []) {
    const querySql = normalizedSql(sql);
    this.queries.push({ sql: querySql, params });

    if (querySql === "BEGIN") {
      assert.equal(this.transactionStart, null, "nested transaction");
      this.transactionStart = structuredClone(this.state);
      return { rows: [] };
    }
    if (querySql === "COMMIT") {
      this.requireTransaction();
      this.transactionStart = null;
      this.lockedTables.clear();
      this.advisoryLocked = false;
      return { rows: [] };
    }
    if (querySql === "ROLLBACK") {
      this.requireTransaction();
      this.state = this.transactionStart;
      this.transactionStart = null;
      this.lockedTables.clear();
      this.advisoryLocked = false;
      return { rows: [] };
    }
    if (/pg_advisory_xact_lock\(736846420260811\)/i.test(querySql)) {
      this.requireTransaction();
      this.advisoryLocked = true;
      return { rows: [] };
    }
    if (/^LOCK TABLE /i.test(querySql)) {
      this.requireTransaction();
      assert.equal(this.advisoryLocked, true, "table locks acquired before advisory lock");
      assert.match(querySql, /IN ACCESS EXCLUSIVE MODE$/i);
      const expected = this.lastObservedSourceInventory;
      assert.ok(expected, "source inventory was not refreshed before table locking");
      const actual = [...querySql.matchAll(/"public"\."([^"]+)"/g)].map((match) => match[1]);
      assert.deepEqual(actual, expected, "wrong source lock inventory or order");
      for (const match of querySql.matchAll(/"public"\."([^"]+)"/g)) {
        assert.ok(this.state.publicTables[match[1]] || match[1] === "_davantti_sql_migrations");
        this.lockedTables.add(match[1]);
      }
      if (this.addTableDuringLock) {
        const tableName = this.addTableDuringLock;
        this.state.publicTables[tableName] = {
          columns: ["id"],
          rows: [{ id: `${tableName}-race` }],
        };
        this.addTableDuringLock = null;
      }
      return { rows: [] };
    }
    if (querySql.includes("affected source table inventory")) {
      this.requireTransaction();
      assert.equal(this.advisoryLocked, true, "source inventory inspected before advisory lock");
      assert.match(querySql, /pg_class/i);
      assert.match(querySql, /n\.nspname = 'public'/i);
      const fixedOrder = [
        ...Object.keys(SHARED_CONTAMINATED_COLUMNS),
        ...AVANTRACKING_ONLY_TABLES,
        "_davantti_sql_migrations",
      ];
      const observed = fixedOrder.filter((tableName) => (
        tableName === "_davantti_sql_migrations" || this.state.publicTables[tableName]
      ));
      this.lastObservedSourceInventory = observed;
      return { rows: observed.map((tableName) => ({ tableName })) };
    }
    if (querySql.includes("pre-repair foreign keys")) {
      for (const tableName of [
        ...Object.keys(SHARED_CONTAMINATED_COLUMNS),
        ...this.plan.repairContext.activeAvantrackingObjects,
        "_davantti_sql_migrations",
      ]) this.requireLocked(tableName);
      return { rows: structuredClone(this.state.foreignKeys) };
    }
    if (querySql.includes("locked source row counts")) {
      assert.match(querySql, /COUNT\(\*\)::bigint AS "rowCount"/i);
      assert.doesNotMatch(querySql, /SELECT 1|WHERE FALSE/i);
      for (const tableName of this.lastObservedSourceInventory) {
        assert.match(querySql, new RegExp(`FROM "public"\\."${tableName}"`));
      }
      assert.match(querySql, /WHERE "name" = ANY\(\$\d+::text\[\]\)/i);
      const rows = Object.entries(this.state.publicTables).map(([sourceTable, table]) => ({
        sourceTable,
        rowCount: String(table.rows.length),
      }));
      rows.push({ sourceTable: "_davantti_sql_migrations", rowCount: String(this.state.history.length) });
      rows.push({
        sourceTable: "_davantti_sql_migrations:misplaced",
        rowCount: String(this.state.history.filter(({ name }) => MISPLACED_MIGRATIONS.includes(name)).length),
      });
      return { rows };
    }
    if (querySql.includes("locked migration snapshot evidence")) {
      this.requireLocked("_davantti_sql_migrations");
      assert.match(querySql, /to_jsonb\(history_row\)::text AS "rowData"/i);
      assert.match(querySql, /WHERE history_row\."name" = ANY\(\$1::text\[\]\)/i);
      assert.deepEqual(params, [MISPLACED_MIGRATIONS]);
      return { rows: this.state.history
        .filter(({ name }) => MISPLACED_MIGRATIONS.includes(name))
        .map((snapshot) => ({ name: snapshot.name, rowData: JSON.stringify(snapshot) })) };
    }
    if (querySql.includes("locked shared snapshot evidence")) {
      const sourceTable = params[0];
      this.requireLocked(sourceTable);
      assert.match(querySql, /source_row\."id"::text AS "originalId"/i);
      assert.match(querySql, /to_jsonb\(source_row\)::text AS "rowData"/i);
      assert.doesNotMatch(querySql, /WHERE FALSE/i);
      return { rows: this.rowsFor(sourceTable).map((snapshot) => ({
        sourceTable,
        originalId: String(snapshot.id),
        rowData: this.sourceJsonbText[sourceTable]?.[String(snapshot.id)] || JSON.stringify(snapshot),
      })) };
    }
    if (/^CREATE SCHEMA IF NOT EXISTS /i.test(querySql)) {
      this.requireTransaction();
      this.state.quarantine ||= { tables: {}, migrationHistory: {}, sharedSnapshots: {}, manifest: null };
      return { rows: [] };
    }
    if (/^CREATE TABLE IF NOT EXISTS /i.test(querySql)) {
      this.requireTransaction();
      assert.ok(this.state.quarantine, "quarantine schema missing");
      return { rows: [] };
    }
    if (/INSERT INTO .*"repair_manifest"/i.test(querySql)) {
      this.requireTransaction();
      assert.equal(params[0], "repair-plan");
      this.state.quarantine.manifest = JSON.parse(params[1]);
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO .*"migration_history"/i.test(querySql)) {
      this.requireLocked("_davantti_sql_migrations");
      assert.match(querySql, /to_jsonb\(history_row\)/i);
      assert.match(querySql, /WHERE history_row\."name" = ANY\(\$1::text\[\]\)/i);
      assert.doesNotMatch(querySql, /WHERE FALSE/i);
      assert.deepEqual(params, [MISPLACED_MIGRATIONS]);
      for (const row of this.state.history.filter(({ name }) => params[0].includes(name))) {
        this.state.quarantine.migrationHistory[row.name] = structuredClone(row);
      }
      return { rows: [], rowCount: Object.keys(this.state.quarantine.migrationHistory).length };
    }
    if (/INSERT INTO .*"shared_row_snapshots"/i.test(querySql)) {
      const sourceTable = params[0];
      this.requireLocked(sourceTable);
      assert.match(querySql, /to_jsonb\(source_row\)/i);
      assert.match(querySql, /FROM "public"\."[^"]+" AS source_row ORDER BY source_row\."id"::text$/i);
      assert.doesNotMatch(querySql, /WHERE FALSE/i);
      this.state.quarantine.sharedSnapshots[sourceTable] = structuredClone(this.rowsFor(sourceTable));
      this.state.quarantine.sharedSnapshotRowData ||= {};
      this.state.quarantine.sharedSnapshotRowData[sourceTable] = Object.fromEntries(
        this.rowsFor(sourceTable).map((snapshot) => [
          String(snapshot.id),
          this.sourceJsonbText[sourceTable]?.[String(snapshot.id)] || JSON.stringify(snapshot),
        ]),
      );
      return { rows: [], rowCount: this.rowsFor(sourceTable).length };
    }
    const dropConstraint = querySql.match(/^ALTER TABLE "public"\."([^"]+)" DROP CONSTRAINT "([^"]+)"$/i);
    if (dropConstraint) {
      this.requireLocked(dropConstraint[1]);
      const index = this.state.foreignKeys.findIndex(({ constraintName }) => constraintName === dropConstraint[2]);
      assert.notEqual(index, -1, `missing FK ${dropConstraint[2]}`);
      this.state.foreignKeys.splice(index, 1);
      return { rows: [] };
    }
    const moveTable = querySql.match(/^ALTER TABLE "public"\."([^"]+)" SET SCHEMA "([^"]+)"$/i);
    if (moveTable) {
      this.requireLocked(moveTable[1]);
      const table = this.state.publicTables[moveTable[1]];
      assert.ok(table, `missing source table ${moveTable[1]}`);
      this.state.quarantine.tables[moveTable[1]] = table;
      delete this.state.publicTables[moveTable[1]];
      return { rows: [] };
    }
    const dropColumns = querySql.match(/^ALTER TABLE "public"\."([^"]+)" (.+)$/i);
    if (dropColumns && /DROP COLUMN/i.test(dropColumns[2])) {
      this.requireLocked(dropColumns[1]);
      assert.ok(this.state.quarantine.sharedSnapshots[dropColumns[1]], `missing snapshot for ${dropColumns[1]}`);
      const dropped = [...dropColumns[2].matchAll(/DROP COLUMN IF EXISTS "([^"]+)"/gi)].map((match) => match[1]);
      const expected = SHARED_CONTAMINATED_COLUMNS[dropColumns[1]];
      assert.deepEqual(dropped, expected, `malformed column drop for ${dropColumns[1]}`);
      this.state.publicTables[dropColumns[1]].columns = this.state.publicTables[dropColumns[1]].columns
        .filter((column) => !dropped.includes(column));
      return { rows: [] };
    }
    if (/^DELETE FROM "public"\."_davantti_sql_migrations"/i.test(querySql)) {
      this.requireLocked("_davantti_sql_migrations");
      assert.match(querySql, /^DELETE FROM "public"\."_davantti_sql_migrations" WHERE "name" = ANY\(\$1::text\[\]\)$/i);
      assert.deepEqual(params, [MISPLACED_MIGRATIONS]);
      assert.equal(Object.keys(this.state.quarantine.migrationHistory).length, MISPLACED_MIGRATIONS.length);
      this.state.history = this.state.history.filter(({ name }) => !params[0].includes(name));
      return { rows: [], rowCount: MISPLACED_MIGRATIONS.length };
    }
    if (querySql.includes("post-repair table locations")) {
      return { rows: [
        ...AVANTRACKING_ONLY_TABLES.filter((name) => this.state.publicTables[name]).map((tableName) => ({ tableName, tableSchema: "public" })),
        ...AVANTRACKING_ONLY_TABLES.filter((name) => this.state.quarantine?.tables[name]).map((tableName) => ({ tableName, tableSchema: QUARANTINE_SCHEMA })),
      ] };
    }
    if (querySql.includes("post-repair foreign keys")) {
      return { rows: this.state.foreignKeys.filter(({ constraintName }) => KNOWN_CONTAMINATED_FKS.has(constraintName)) };
    }
    if (querySql.includes("post-repair shared columns")) {
      return { rows: Object.keys(SHARED_CONTAMINATED_COLUMNS).flatMap((tableName) => (
        this.state.publicTables[tableName].columns.map((columnName) => ({ tableName, columnName }))
      )) };
    }
    if (querySql.includes("post-repair migration history")) {
      return { rows: this.state.history.map(({ name }) => ({ name, totalCount: String(this.state.history.length) })) };
    }
    if (querySql.includes("post-repair quarantine migrations")) {
      return { rows: Object.entries(this.state.quarantine.migrationHistory)
        .map(([name, snapshot]) => ({ name, rowData: JSON.stringify(snapshot) })) };
    }
    if (querySql.includes("post-repair shared snapshots")) {
      return { rows: Object.entries(this.state.quarantine.sharedSnapshots).flatMap(([sourceTable, rows]) => (
        rows.map((snapshot) => ({
          sourceTable,
          originalId: String(snapshot.id),
          rowData: this.state.quarantine.sharedSnapshotRowData[sourceTable][String(snapshot.id)],
        }))
      )) };
    }
    if (querySql.includes("post-repair quarantine table row counts")) {
      return { rows: params.map((sourceTable) => ({
        sourceTable,
        rowCount: String(this.state.quarantine.tables[sourceTable]?.rows.length || 0),
      })) };
    }
    if (querySql.includes("post-repair manifest")) {
      const snapshot = structuredClone(this.state.quarantine.manifest);
      if (this.tamperManifestOnRead) snapshot.sourceRowCounts.User += 1;
      return { rows: snapshot ? [{ snapshot }] : [] };
    }

    if (/^SELECT name FROM "public"\."_davantti_sql_migrations" ORDER BY name$/i.test(querySql)) {
      if (this.transactionStart && !this.state.quarantine) this.requireLocked("_davantti_sql_migrations");
      return { rows: this.state.history.map(({ name }) => ({ name })) };
    }
    if (querySql.includes("pg_class object inventory")) {
      return { rows: AVANTRACKING_ONLY_TABLES
        .filter((tableName) => this.state.publicTables[tableName])
        .map((tableName) => ({ tableName })) };
    }
    if (querySql.includes("pg_constraint foreign keys")) {
      if (this.transactionStart && !this.state.quarantine) {
        for (const tableName of this.lastObservedSourceInventory) this.requireLocked(tableName);
      }
      return { rows: structuredClone(this.state.foreignKeys) };
    }
    if (querySql.includes("information_schema critical columns")) return { rows: [] };
    if (querySql.includes("non-numeric User ids")) return { rows: [{ count: "0" }] };
    if (querySql.includes("row count for Avantracking-only table")) {
      const tableName = querySql.match(/FROM "public"\."([^"]+)"/i)?.[1];
      return { rows: [{ count: String(this.rowsFor(tableName).length) }] };
    }
    if (querySql.includes("repair state objects")) return { rows: [{
      schemaExists: Boolean(this.state.quarantine),
      manifestTableExists: Boolean(this.state.quarantine),
      migrationHistoryTableExists: Boolean(this.state.quarantine),
      sharedSnapshotsTableExists: Boolean(this.state.quarantine),
    }] };
    if (querySql.includes("repair state manifest")) {
      return { rows: this.state.quarantine?.manifest
        ? [{ snapshot: structuredClone(this.state.quarantine.manifest) }]
        : [] };
    }
    if (querySql.includes("repair state table locations")) return { rows: [
      ...AVANTRACKING_ONLY_TABLES.filter((name) => this.state.publicTables[name])
        .map((tableName) => ({ tableName, tableSchema: "public" })),
      ...AVANTRACKING_ONLY_TABLES.filter((name) => this.state.quarantine?.tables[name])
        .map((tableName) => ({ tableName, tableSchema: QUARANTINE_SCHEMA })),
    ] };
    if (querySql.includes("repair state forbidden foreign keys")) return { rows: [] };
    if (querySql.includes("repair state migration snapshots")) return { rows: Object.entries(
      this.state.quarantine.migrationHistory,
    ).map(([name, snapshot]) => ({ name, rowData: JSON.stringify(snapshot) })) };
    if (querySql.includes("repair state shared snapshot evidence")) return { rows: Object.entries(
      this.state.quarantine.sharedSnapshots,
    ).flatMap(([sourceTable, rows]) => rows.map((snapshot) => ({
      sourceTable,
      originalId: String(snapshot.id),
      rowData: this.state.quarantine.sharedSnapshotRowData[sourceTable][String(snapshot.id)],
    }))) };
    if (querySql.includes("repair state source row counts")) return { rows: Object.entries(
      this.state.quarantine.tables,
    ).map(([sourceTable, table]) => ({ sourceTable, rowCount: String(table.rows.length) })) };
    if (querySql.includes("repair state shared columns")) return { rows: Object.entries(
      SHARED_CONTAMINATED_COLUMNS,
    ).flatMap(([tableName]) => this.state.publicTables[tableName].columns.map((columnName) => ({
      tableName,
      columnName,
    }))) };

    assert.fail(`unrecognized behavioral SQL: ${querySql}`);
  }
}

function planWithout(plan, operationName) {
  const filtered = plan.filter(({ name }) => name !== operationName);
  filtered.repairContext = plan.repairContext;
  return filtered;
}

function fakeClient({ target, rowsByQuery }) {
  const queries = [];
  return {
    databaseTarget: target,
    queries,
    async query(sql, params = []) {
      assert.doesNotMatch(sql, WRITE_SQL, `inspection emitted write SQL: ${sql}`);
      queries.push({ sql, params });
      const entry = Object.entries(rowsByQuery).find(([marker]) => sql.includes(marker));
      assert.ok(entry, `unexpected inspection query: ${sql}`);
      return { rows: entry[1] };
    },
  };
}

test("uses the exact eleven misplaced Avantracking migrations", () => {
  assert.deepEqual(MISPLACED_MIGRATIONS, EXPECTED_MIGRATIONS);
  assert.equal(Object.isFrozen(MISPLACED_MIGRATIONS), true);
});

test("uses only the explicit Avantracking-only tables and shared-column manifest", () => {
  assert.deepEqual(AVANTRACKING_ONLY_TABLES, [
    "Carrier",
    "Company",
    "CompanyOrderCustomStatus",
    "LogisyncUser",
    "MonitoredOrder",
    "SyncNotification",
    "TrackingEvent",
    "TrayAuth",
    "TrayCheckoutQuote",
    "UserAccessToken",
  ]);
  assert.equal(SHARED_CONTAMINATED_COLUMNS.User.includes("userGlobalId"), false);
  assert.deepEqual(SHARED_CONTAMINATED_COLUMNS.ReleaseNote, ["sentByUserId"]);
});

test("uses the exact canonical Shopee User FK whitelist", () => {
  assert.deepEqual(CANONICAL_SHOPEE_USER_FK_TUPLES, EXPECTED_CANONICAL_SHOPEE_USER_FKS);
});

for (const [constraintName, sourceTable, sourceColumn, targetTable, targetColumn] of EXPECTED_CANONICAL_SHOPEE_USER_FKS) {
  test(`preflight accepts canonical Shopee FK ${constraintName}`, () => {
    const report = validReport();
    report.foreignKeys.push({
      constraintName,
      sourceTable,
      sourceColumn,
      targetTable,
      targetColumn,
    });

    assert.doesNotThrow(() => validatePreflight(report, report.shopeeTarget.fingerprint));
  });
}

test("preflight rejects an unknown external foreign key", () => {
  const report = validReport();
  report.foreignKeys.push({
    constraintName: "MonitoredOrder_unexpectedUserId_fkey",
    sourceTable: "MonitoredOrder",
    sourceColumn: "unexpectedUserId",
    targetTable: "User",
    targetColumn: "id",
  });

  assert.throws(
    () => validatePreflight(report, report.shopeeTarget.fingerprint),
    /foreign key externo desconhecido/i,
  );
});

test("preflight rejects an unlisted ReleaseNote foreign key targeting User.id", () => {
  const report = validReport();
  report.foreignKeys.push({
    constraintName: "ReleaseNote_unexpectedUserId_fkey",
    sourceTable: "ReleaseNote",
    sourceColumn: "unexpectedUserId",
    targetTable: "User",
    targetColumn: "id",
  });

  assert.throws(
    () => validatePreflight(report, report.shopeeTarget.fingerprint),
    /foreign key externo desconhecido/i,
  );
});

test("preflight rejects a known Avantracking FK name with unexpected endpoints", () => {
  const report = validReport();
  const foreignKey = report.foreignKeys.find(
    ({ constraintName }) => constraintName === "Order_createdById_fkey",
  );
  foreignKey.targetColumn = "unexpectedId";

  assert.throws(
    () => validatePreflight(report, report.shopeeTarget.fingerprint),
    /foreign key externo desconhecido/i,
  );
});

test("preflight rejects a Shopee target whose observed database differs from configuration", () => {
  const report = validReport();
  report.shopeeTarget = {
    fingerprint: report.shopeeTarget.fingerprint,
    configuredDatabase: "shopee",
    configuredSchema: "public",
    observedDatabase: "other_database",
    observedSchema: "public",
  };

  assert.throws(
    () => validatePreflight(report, report.shopeeTarget.fingerprint),
    /banco observado/i,
  );
});

test("preflight rejects a Shopee target whose observed schema differs from configuration", () => {
  const report = validReport();
  report.shopeeTarget = {
    fingerprint: report.shopeeTarget.fingerprint,
    configuredDatabase: "shopee",
    configuredSchema: "public",
    observedDatabase: "shopee",
    observedSchema: "other_schema",
  };

  assert.throws(
    () => validatePreflight(report, report.shopeeTarget.fingerprint),
    /schema observado/i,
  );
});

test("preflight rejects a missing Avantracking reference migration", () => {
  const report = validReport();
  report.avantrackingAppliedMigrations.delete(MISPLACED_MIGRATIONS[0]);

  assert.throws(
    () => validatePreflight(report, report.shopeeTarget.fingerprint),
    /migration ausente/i,
  );
});

test("preflight rejects a mismatched Shopee target fingerprint", () => {
  const report = validReport();

  assert.throws(
    () => validatePreflight(report, "not-the-shopee-target"),
    /fingerprint/i,
  );
});

test("inspection returns masked identities and read-only contamination inventory", async () => {
  const rowsByQuery = {
    "current_database": [{ database: "shopee", schema: "public" }],
    "Avantracking reference migration snapshots": validReport().avantrackingMigrationSnapshots,
    "_davantti_sql_migrations": MISPLACED_MIGRATIONS.map((name) => ({ name })),
    "pg_class object inventory": AVANTRACKING_ONLY_TABLES.map((tableName) => ({ tableName })),
    "pg_constraint foreign keys": [{
      constraintName: "MonitoredOrder_createdById_fkey",
      sourceTable: "MonitoredOrder",
      sourceColumn: "createdById",
      targetTable: "User",
      targetColumn: "id",
    }],
    "information_schema critical columns": [{
      tableName: "User",
      columnName: "id",
      udtName: "text",
    }],
    "non-numeric User ids": [{ count: "0" }],
    "row count for": [{ count: "3" }],
    "repair state objects": [{
      schemaExists: false,
      manifestTableExists: false,
      migrationHistoryTableExists: false,
      sharedSnapshotsTableExists: false,
    }],
  };
  const shopeeClient = fakeClient({
    target: {
      fingerprint: "271508fcaaff",
      database: "shopee",
      schema: "public",
    },
    rowsByQuery,
  });
  const avantrackingClient = fakeClient({
    target: { fingerprint: "9d5db7fc1b75" },
    rowsByQuery,
  });

  const report = await inspectContamination(shopeeClient, avantrackingClient);

  assert.equal(report.shopeeTarget.fingerprint, "271508fcaaff");
  assert.equal(report.shopeeTarget.observedDatabase, "shopee");
  assert.equal(report.shopeeTarget.observedSchema, "public");
  assert.equal(report.avantrackingTarget.fingerprint, "9d5db7fc1b75");
  assert.equal(report.shopeeAppliedMigrations.size, 11);
  assert.equal(report.avantrackingAppliedMigrations.size, 11);
  assert.equal(report.activeAvantrackingObjects.length, 10);
  assert.equal(report.tableRowCounts.get("Carrier"), 3);
  assert.equal(report.nonNumericUserIdCount, 0);
  assert.equal(report.foreignKeys[0].constraintName, "MonitoredOrder_createdById_fkey");
  assert.deepEqual(report.repairState, { status: "not-repaired" });
  assert.ok(shopeeClient.queries.length > 0);
  assert.ok(avantrackingClient.queries.length > 0);
});

test("read-only repair inspection recognizes valid completion and rejects inconsistent evidence", async () => {
  const plan = buildRepairPlan(validReport());
  const statefulClient = new StatefulRepairClient(plan);
  await executeRepair(statefulClient, plan);
  const manifest = statefulClient.state.quarantine.manifest;
  const currentReport = repairedReport(manifest);
  delete currentReport.repairState;

  function evidenceClient({ sharedSnapshotDelta = 0, forbiddenForeignKeys = [] } = {}) {
    const queries = [];
    return {
      queries,
      async query(sql) {
        assert.doesNotMatch(sql, WRITE_SQL);
        const querySql = normalizedSql(sql);
        queries.push(querySql);
        if (querySql.includes("repair state objects")) return { rows: [{
          schemaExists: true,
          manifestTableExists: true,
          migrationHistoryTableExists: true,
          sharedSnapshotsTableExists: true,
        }] };
        if (querySql.includes("repair state manifest")) return { rows: [{ snapshot: manifest }] };
        if (querySql.includes("repair state table locations")) return { rows: AVANTRACKING_ONLY_TABLES.map(
          (tableName) => ({ tableName, tableSchema: QUARANTINE_SCHEMA }),
        ) };
        if (querySql.includes("repair state migration snapshots")) {
          return { rows: structuredClone(manifest.recovery.migrationSnapshots) };
        }
        if (querySql.includes("repair state forbidden foreign keys")) {
          return { rows: forbiddenForeignKeys };
        }
        if (querySql.includes("repair state shared snapshot evidence")) {
          const rows = Object.entries(statefulClient.state.quarantine.sharedSnapshots)
            .flatMap(([sourceTable, snapshots]) => snapshots.map((snapshot) => ({
              sourceTable,
              originalId: String(snapshot.id),
              rowData: statefulClient.state.quarantine.sharedSnapshotRowData[sourceTable][String(snapshot.id)],
            })));
          if (sharedSnapshotDelta) rows.push({
            sourceTable: "User",
            originalId: "unexpected",
            rowData: "{\"id\":\"unexpected\"}",
          });
          return { rows };
        }
        if (querySql.includes("repair state source row counts")) return { rows: [
          ...AVANTRACKING_ONLY_TABLES.map((sourceTable) => ({ sourceTable, rowCount: "2" })),
        ] };
        if (querySql.includes("repair state shared columns")) return { rows: manifest.staticEvidence.canonicalColumns.map(
          ([tableName, columnName]) => ({ tableName, columnName }),
        ) };
        assert.fail(`unexpected repair evidence query: ${querySql}`);
      },
    };
  }

  const validClient = evidenceClient();
  assert.deepEqual(await inspectRepairState(validClient, currentReport), {
    status: "repaired",
    manifest,
  });
  assert.ok(validClient.queries.length >= 7);

  const inconsistent = await inspectRepairState(
    evidenceClient({ sharedSnapshotDelta: 1 }),
    currentReport,
  );
  assert.equal(inconsistent.status, "partial");
  assert.match(inconsistent.reason, /snapshot|contagem/i);

  const retainedForeignKey = await inspectRepairState(evidenceClient({
    forbiddenForeignKeys: [{
      constraintName: "UserAccessToken_userId_fkey",
      sourceSchema: QUARANTINE_SCHEMA,
      targetSchema: "public",
    }],
  }), currentReport);
  assert.equal(retainedForeignKey.status, "partial");
  assert.match(retainedForeignKey.reason, /foreign key/i);
});

test("dry-run summary exposes only fingerprints and counts", () => {
  const summary = buildDryRunSummary({
    ...validReport(),
    shopeeAppliedMigrations: new Set([...MISPLACED_MIGRATIONS, "canonical-shopee-migration"]),
    avantrackingAppliedMigrations: new Set([...MISPLACED_MIGRATIONS, "later-avantracking-migration"]),
    activeAvantrackingObjects: ["Carrier", "Company"],
    tableRowCounts: new Map([["Carrier", 3], ["Company", 2]]),
    criticalColumnTypes: [{ tableName: "User", columnName: "id", udtName: "text" }],
    foreignKeys: [{ constraintName: "User_companyId_fkey" }],
    nonNumericUserIdCount: 0,
  });

  assert.deepEqual(summary, {
    writeMode: false,
    shopeeTarget: { fingerprint: "271508fcaaff" },
    avantrackingTarget: { fingerprint: "9d5db7fc1b75" },
    counts: {
      misplacedMigrations: 11,
      avantrackingReferenceMigrations: 11,
      activeAvantrackingObjects: 2,
      activeAvantrackingRows: 5,
      foreignKeys: 1,
      criticalColumns: 1,
      nonNumericUserIds: 0,
    },
  });
  assert.doesNotMatch(JSON.stringify(summary), /postgres(?:ql)?:\/\//i);
});

test("repair plan is deterministic and follows the required quarantine order", () => {
  const report = validReport();
  const firstPlan = buildRepairPlan(report);
  const secondPlan = buildRepairPlan(report);
  const operationNames = firstPlan.map(({ name }) => name);

  assert.deepEqual(firstPlan, secondPlan);
  assert.equal(QUARANTINE_SCHEMA, "quarantine_avantracking_20260811");
  assert.equal(operationNames[0], "acquire-advisory-lock");
  assert.equal(operationNames[1], "reinspect-repair-state-after-advisory");
  assert.equal(operationNames[2], "refresh-lock-revalidate-source-inventory");
  assert.equal(operationNames[3], "validate-current-foreign-keys");
  assert.match(firstPlan[0].sql, /pg_advisory_xact_lock\(736846420260811\)/i);
  assert.equal(firstPlan[2].action, "refreshLockRevalidateSourceInventory");
  assert.ok(operationNames.indexOf("validate-current-foreign-keys") < operationNames.indexOf("capture-locked-source-row-counts"));
  assert.ok(operationNames.indexOf("capture-locked-source-row-counts") < operationNames.indexOf("create-quarantine-schema"));
  assert.ok(operationNames.indexOf("create-quarantine-schema") < operationNames.indexOf("snapshot-migration-history"));
  assert.ok(operationNames.indexOf("snapshot-migration-history") < operationNames.indexOf("snapshot-shared-User"));
  assert.ok(operationNames.indexOf("snapshot-shared-ReleaseNote") < operationNames.indexOf("drop-fk-LogisyncUser_companyId_fkey"));
  assert.ok(operationNames.indexOf("drop-fk-UserAccessToken_userId_fkey") < operationNames.indexOf("move-table-Carrier"));
  assert.ok(operationNames.indexOf("move-table-UserAccessToken") < operationNames.indexOf("drop-columns-User"));
  assert.ok(operationNames.indexOf("drop-columns-ReleaseNote") < operationNames.indexOf("delete-misplaced-migration-history"));

  const historySnapshot = firstPlan.find(({ name }) => name === "snapshot-migration-history");
  assert.match(historySnapshot.sql, /to_jsonb\(history_row\)/i);
  assert.deepEqual(historySnapshot.params, [MISPLACED_MIGRATIONS]);

  for (const tableName of Object.keys(SHARED_CONTAMINATED_COLUMNS)) {
    const snapshot = firstPlan.find(({ name }) => name === `snapshot-shared-${tableName}`);
    assert.match(snapshot.sql, /to_jsonb\(source_row\)/i);
    assert.match(snapshot.sql, /source_row\."id"::text/i);
    assert.deepEqual(snapshot.params, [tableName]);
  }

  const deletion = firstPlan.find(({ name }) => name === "delete-misplaced-migration-history");
  assert.deepEqual(deletion.params, [MISPLACED_MIGRATIONS]);
});

test("repair plan never drops tables or canonical Shopee columns", () => {
  const plan = buildRepairPlan(validReport());
  const sql = plan.map((operation) => operation.sql).join("\n");
  const columnDropSql = plan
    .filter(({ name }) => name.startsWith("drop-columns-"))
    .map(({ sql: operationSql }) => operationSql)
    .join("\n");

  assert.doesNotMatch(sql, /DROP\s+TABLE/i);
  assert.match(sql, /SET\s+SCHEMA\s+"quarantine_avantracking_20260811"/i);
  assert.doesNotMatch(columnDropSql, /"userGlobalId"|"accountId"|"orderSn"|"orderStatus"/i);

  const droppedColumns = [...columnDropSql.matchAll(/DROP\s+COLUMN\s+IF\s+EXISTS\s+"([^"]+)"/gi)]
    .map((match) => match[1]);
  const allowedColumns = Object.values(SHARED_CONTAMINATED_COLUMNS).flat();
  assert.deepEqual([...droppedColumns].sort(), [...allowedColumns].sort());
});

test("repair plan drops only exact observed known contaminated foreign keys", () => {
  const report = validReport();
  report.foreignKeys = report.foreignKeys.filter(({ constraintName }) => (
    constraintName === "Order_createdById_fkey" || constraintName === "User_companyId_fkey"
  ));

  const plan = buildRepairPlan(report);
  const foreignKeyDrops = plan.filter(({ name }) => name.startsWith("drop-fk-"));

  assert.deepEqual(foreignKeyDrops.map(({ name }) => name), [
    "drop-fk-Order_createdById_fkey",
    "drop-fk-User_companyId_fkey",
  ]);
  assert.match(foreignKeyDrops[0].sql, /ALTER TABLE "public"\."Order" DROP CONSTRAINT "Order_createdById_fkey"/i);
  assert.match(foreignKeyDrops[1].sql, /ALTER TABLE "public"\."User" DROP CONSTRAINT "User_companyId_fkey"/i);
});

test("static operation kinds remain valid when repeat groups have zero observed operations", async () => {
  const report = validReport();
  report.activeAvantrackingObjects = [];
  report.foreignKeys = [];
  const plan = buildRepairPlan(report);
  const client = new StatefulRepairClient(plan);

  const result = await executeRepair(client, plan);

  assert.equal(result.committed, true);
  assert.equal(result.movedTableCount, 0);
});

test("repair planning refuses an unknown cross-boundary foreign key", () => {
  const report = validReport();
  report.foreignKeys.push({
    constraintName: "Unknown_companyId_fkey",
    sourceTable: "Order",
    sourceColumn: "companyId",
    targetTable: "Company",
    targetColumn: "id",
  });

  assert.throws(() => buildRepairPlan(report), /foreign key externo desconhecido/i);
});

test("executeRepair verifies the repaired state before committing", async () => {
  const plan = buildRepairPlan(validReport());
  const client = new StatefulRepairClient(plan);

  const result = await executeRepair(client, plan);
  const sql = client.queries.map(({ sql: querySql }) => querySql);
  const commitIndex = sql.indexOf("COMMIT");
  const lastPostCheckIndex = sql.findLastIndex((querySql) => querySql.includes("post-repair"));

  assert.equal(sql[0], "BEGIN");
  assert.match(sql[1], /pg_advisory_xact_lock\(736846420260811\)/i);
  assert.match(sql[2], /repair state objects/i);
  assert.match(sql[3], /affected source table inventory/i);
  assert.match(sql[4], /^LOCK TABLE .* IN ACCESS EXCLUSIVE MODE$/i);
  assert.match(sql[5], /affected source table inventory/i);
  assert.ok(lastPostCheckIndex > 0);
  assert.ok(commitIndex > lastPostCheckIndex);
  assert.equal(sql.includes("ROLLBACK"), false);
  assert.deepEqual(result, {
    committed: true,
    noOp: false,
    operationCount: plan.length,
    movedTableCount: AVANTRACKING_ONLY_TABLES.length,
    quarantinedMigrationCount: MISPLACED_MIGRATIONS.length,
  });

  const manifest = client.state.quarantine.manifest;
  assert.deepEqual(manifest.sourceRowCounts, {
    User: 3,
    Order: 3,
    ReleaseNote: 3,
    Carrier: 2,
    Company: 2,
    CompanyOrderCustomStatus: 2,
    LogisyncUser: 2,
    MonitoredOrder: 2,
    SyncNotification: 2,
    TrackingEvent: 2,
    TrayAuth: 2,
    TrayCheckoutQuote: 2,
    UserAccessToken: 2,
    _davantti_sql_migrations: 12,
    "_davantti_sql_migrations:misplaced": 11,
  });
  assert.deepEqual(manifest.operations.map(({ name }) => name), plan.map(({ name }) => name));
  assert.equal(manifest.format, "davantti-shopee-avantracking-repair");
  assert.equal(manifest.version, 3);
  assert.match(manifest.evidenceSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.recovery.migrationSnapshots.length, MISPLACED_MIGRATIONS.length);
  assert.equal(manifest.recovery.sharedSnapshotEvidence.length, 3);
  assert.deepEqual(manifest.recovery.activeAvantrackingObjects, AVANTRACKING_ONLY_TABLES);
  assert.deepEqual(manifest.recovery.unrelatedMigrationNames, ["canonical-shopee-migration"]);
  assert.deepEqual(manifest.staticEvidence.misplacedMigrationNames, MISPLACED_MIGRATIONS);
});

test("executeRepair rolls back when post-repair verification fails", async () => {
  const completePlan = buildRepairPlan(validReport());
  const plan = planWithout(completePlan, "move-table-Carrier");
  const client = new StatefulRepairClient(plan);
  const before = structuredClone(client.state);

  await assert.rejects(() => executeRepair(client, plan), /public/i);

  const sql = client.queries.map(({ sql: querySql }) => querySql);
  assert.equal(sql.at(-1), "ROLLBACK");
  assert.equal(sql.includes("COMMIT"), false);
  assert.deepEqual(client.state, before);
});

test("executeRepair rejects changed foreign keys before the first schema mutation", async () => {
  const plan = buildRepairPlan(validReport());
  const client = new StatefulRepairClient(plan);
  client.state.foreignKeys.push({
    constraintName: "Unknown_companyId_fkey",
    sourceTable: "Order",
    sourceColumn: "companyId",
    targetTable: "Company",
    targetColumn: "id",
  });

  await assert.rejects(() => executeRepair(client, plan), /foreign key externo desconhecido/i);

  const sql = client.queries.map(({ sql: querySql }) => querySql);
  assert.equal(sql.some((querySql) => /CREATE SCHEMA/i.test(querySql)), false);
  assert.equal(sql.at(-1), "ROLLBACK");
});

test("executeRepair rolls back if an unrelated migration record is missing", async () => {
  const plan = buildRepairPlan(validReport());
  const client = new StatefulRepairClient(plan);
  client.state.history = client.state.history.filter(({ name }) => name !== "canonical-shopee-migration");

  await assert.rejects(() => executeRepair(client, plan), /historico de migrations mudou/i);
  assert.equal(client.queries.at(-1).sql, "ROLLBACK");
});

test("executeRepair refuses to mutate when the source lock operation is missing", async () => {
  const completePlan = buildRepairPlan(validReport());
  const plan = planWithout(completePlan, "refresh-lock-revalidate-source-inventory");
  const client = new StatefulRepairClient(plan);
  const before = structuredClone(client.state);

  await assert.rejects(() => executeRepair(client, plan), /blueprint|lock/i);

  assert.deepEqual(client.state, before);
  assert.equal(client.queries.some(({ sql }) => /CREATE SCHEMA/i.test(sql)), false);
  assert.equal(client.queries.at(-1).sql, "ROLLBACK");
});

test("executeRepair rolls back when a required full-row snapshot operation is missing", async () => {
  const completePlan = buildRepairPlan(validReport());
  const plan = planWithout(completePlan, "snapshot-shared-Order");
  const client = new StatefulRepairClient(plan);
  const before = structuredClone(client.state);

  await assert.rejects(() => executeRepair(client, plan), /ordem estatica|blueprint/i);

  assert.deepEqual(client.state, before);
  assert.equal(client.queries.at(-1).sql, "ROLLBACK");
});

test("stateful harness rejects malformed column mutation SQL and restores all state", async () => {
  const plan = buildRepairPlan(validReport());
  const operation = plan.find(({ name }) => name === "drop-columns-User");
  operation.sql = operation.sql.replace('DROP COLUMN IF EXISTS "password",', "");
  const client = new StatefulRepairClient(plan);
  const before = structuredClone(client.state);

  await assert.rejects(() => executeRepair(client, plan), /malformed column drop for User/i);

  assert.deepEqual(client.state, before);
  assert.equal(client.queries.at(-1).sql, "ROLLBACK");
});

for (const [label, operationName, mutate, expectedError] of [
  ["constant source counts", "capture-locked-source-row-counts", (sql) => sql.replace(/SELECT[\s\S]*/, "SELECT 1"), /count|contagem|SQL/i],
  ["empty shared snapshots", "snapshot-shared-Order", (sql) => `${sql} WHERE FALSE`, /snapshot|predicate|SQL/i],
  ["broad migration deletion", "delete-misplaced-migration-history", (sql) => sql.replace(/WHERE[\s\S]*/i, "WHERE TRUE"), /migration|predicate|SQL/i],
  ["changed lock action", "refresh-lock-revalidate-source-inventory", () => "weakerLockAction", /blueprint|lock/i],
]) {
  test(`stateful harness rejects ${label} and rolls back`, async () => {
    const plan = buildRepairPlan(validReport());
    const operation = plan.find(({ name }) => name === operationName);
    if (operation.action) operation.action = mutate(operation.action);
    else operation.sql = mutate(operation.sql);
    const client = new StatefulRepairClient(plan);
    const before = structuredClone(client.state);

    await assert.rejects(() => executeRepair(client, plan), expectedError);
    assert.deepEqual(client.state, before);
    assert.equal(client.queries.at(-1).sql, "ROLLBACK");
  });
}

test("repaired-state validation rejects tampered complete manifest evidence", async () => {
  const plan = buildRepairPlan(validReport());
  const client = new StatefulRepairClient(plan);
  await executeRepair(client, plan);
  const baseline = structuredClone(client.state.quarantine.manifest);
  const mutations = [
    (manifest) => { manifest.sourceRowCounts.User = 999; },
    (manifest) => { manifest.sourceRowCounts.Order = 0; },
    (manifest) => { manifest.operations = []; },
    (manifest) => { manifest.recovery.contaminatedForeignKeys = []; },
    (manifest) => { manifest.recovery.unrelatedMigrationNames = []; },
    (manifest) => { manifest.staticEvidence.sharedContaminatedColumns = []; },
    (manifest) => { manifest.staticEvidence.canonicalColumns = []; },
    (manifest) => { manifest.recovery.migrationSnapshots[0].rowData = "{}"; },
    (manifest) => { manifest.recovery.sharedSnapshotEvidence[0].contentSha256 = "0".repeat(64); },
  ];

  for (const mutate of mutations) {
    client.state.quarantine.manifest = structuredClone(baseline);
    mutate(client.state.quarantine.manifest);
    const report = await client.inspectCurrentReport();
    assert.equal(report.repairState.status, "partial");
  }
});

test("a stale concurrent apply reclassifies after advisory lock and commits a no-op", async () => {
  const stalePlan = buildRepairPlan(validReport());
  const client = new StatefulRepairClient(stalePlan);
  await executeRepair(client, stalePlan);
  const mutationCount = client.queries.filter(({ sql }) => /^(?:CREATE|INSERT|ALTER|DELETE)/i.test(sql)).length;

  const report = await client.inspectCurrentReport();
  assert.equal(report.repairState.status, "repaired");
  const second = await executeRepair(client, stalePlan);

  assert.equal(second.noOp, true);
  assert.equal(client.queries.filter(({ sql }) => /^(?:CREATE|INSERT|ALTER|DELETE)/i.test(sql)).length, mutationCount);
  const secondBegin = client.queries.map(({ sql }) => sql).lastIndexOf("BEGIN");
  assert.match(client.queries[secondBegin + 1].sql, /pg_advisory_xact_lock/i);
  assert.equal(client.queries.slice(secondBegin).some(({ sql }) => /^LOCK TABLE/i.test(sql)), false);
  assert.equal(client.queries.at(-1).sql, "COMMIT");
});

test("a stale concurrent apply rolls back when completed evidence is inconsistent", async () => {
  const stalePlan = buildRepairPlan(validReport());
  const client = new StatefulRepairClient(stalePlan);
  await executeRepair(client, stalePlan);
  client.state.quarantine.manifest.operations = [];
  const before = structuredClone(client.state);

  await assert.rejects(() => executeRepair(client, stalePlan), /parcial|inconsistente/i);

  assert.deepEqual(client.state, before);
  const secondBegin = client.queries.map(({ sql }) => sql).lastIndexOf("BEGIN");
  assert.equal(client.queries.slice(secondBegin).some(({ sql }) => /^LOCK TABLE/i.test(sql)), false);
  assert.equal(client.queries.at(-1).sql, "ROLLBACK");
});

test("executeRepair refreshes source inventory and repairs a known table that appeared after preflight", async () => {
  const report = validReport();
  report.activeAvantrackingObjects = report.activeAvantrackingObjects.filter(
    (tableName) => tableName !== "TrackingEvent",
  );
  const stalePlan = buildRepairPlan(report);
  const client = new StatefulRepairClient(stalePlan);
  client.state.publicTables.TrackingEvent = {
    columns: ["id"],
    rows: [{ id: "TrackingEvent-late" }],
  };

  const result = await executeRepair(client, stalePlan);

  assert.equal(result.noOp, false);
  assert.ok(client.state.quarantine.tables.TrackingEvent);
  const lock = client.queries.find(({ sql }) => /^LOCK TABLE/i.test(sql));
  assert.match(lock.sql, /"public"\."TrackingEvent"/);
  assert.equal(client.state.quarantine.manifest.recovery.activeAvantrackingObjects.includes("TrackingEvent"), true);
});

test("executeRepair rolls back when affected source inventory changes while locks are acquired", async () => {
  const report = validReport();
  report.activeAvantrackingObjects = report.activeAvantrackingObjects.filter(
    (tableName) => tableName !== "TrackingEvent",
  );
  const stalePlan = buildRepairPlan(report);
  const client = new StatefulRepairClient(stalePlan);
  client.addTableDuringLock = "TrackingEvent";
  const before = structuredClone(client.state);

  await assert.rejects(() => executeRepair(client, stalePlan), /inventario.*mudou|retry|tente novamente/i);

  assert.deepEqual(client.state, before);
  assert.equal(client.queries.at(-1).sql, "ROLLBACK");
});

test("a second stale transaction cannot reuse the prior advisory lock state", async () => {
  const stalePlan = buildRepairPlan(validReport());
  const client = new StatefulRepairClient(stalePlan);
  await executeRepair(client, stalePlan);
  assert.equal(client.advisoryLocked, false);
  const missingAdvisory = planWithout(stalePlan, "acquire-advisory-lock");

  await assert.rejects(() => executeRepair(client, missingAdvisory), /advisory|plano/i);

  assert.equal(client.advisoryLocked, false);
  assert.equal(client.queries.at(-1).sql === "ROLLBACK" || client.transactionStart === null, true);
});

test("repaired-state validation rejects coordinated re-digested static evidence tampering", async () => {
  const plan = buildRepairPlan(validReport());
  const client = new StatefulRepairClient(plan);
  await executeRepair(client, plan);
  const baseline = structuredClone(client.state.quarantine.manifest);
  const mutations = [
    (manifest) => { manifest.format = "rewritten-format"; },
    (manifest) => { manifest.version += 1; },
    (manifest) => { manifest.advisoryLock += 1; },
    (manifest) => { manifest.quarantineSchema = "rewritten_schema"; },
    (manifest) => { manifest.staticEvidence.misplacedMigrationNames = []; },
    (manifest) => { manifest.staticEvidence.knownContaminatedForeignKeyTuples = []; },
    (manifest) => { manifest.staticEvidence.sharedContaminatedColumns = []; },
    (manifest) => { manifest.staticEvidence.canonicalColumns = []; },
    (manifest) => { manifest.staticEvidence.operationKinds = []; },
    (manifest) => { manifest.operations[0].name = "rewritten-operation"; },
  ];

  for (const mutate of mutations) {
    client.state.quarantine.manifest = structuredClone(baseline);
    mutate(client.state.quarantine.manifest);
    resealManifest(client.state.quarantine.manifest);
    const report = await client.inspectCurrentReport();
    assert.equal(report.repairState.status, "partial");
  }
});

test("historical Avan migration metadata reconciliation does not block repair", async () => {
  const reconciledReport = validReport();
  reconciledReport.avantrackingMigrationSnapshots[0].rowData = JSON.stringify({
    name: MISPLACED_MIGRATIONS[0],
    checksum: "reconciled-checksum",
    source: "script-reconciled",
    applied_at: "2026-08-01T00:00:00.000Z",
  });
  const plan = buildRepairPlan(reconciledReport);
  const client = new StatefulRepairClient(plan);
  const result = await executeRepair(client, plan);
  assert.equal(result.committed, true);

  const current = repairedReport(client.state.quarantine.manifest);
  current.avantrackingMigrationSnapshots = reconciledReport.avantrackingMigrationSnapshots;
  const repairedState = await inspectRepairState(client, current);
  assert.equal(repairedState.status, "repaired");
});

test("repair rejects missing or malformed external Avan migration snapshots", async () => {
  const mutations = [
    () => [],
    (snapshots) => snapshots.map((snapshot, index) => (index === 0
      ? { ...snapshot, name: "unexpected_migration" }
      : snapshot)),
    (snapshots) => snapshots.map((snapshot, index) => (index === 0
      ? { ...snapshot, rowData: JSON.stringify({ name: MISPLACED_MIGRATIONS[0] }) }
      : snapshot)),
    (snapshots) => snapshots.map((snapshot, index) => (index === 0
      ? { ...snapshot, rowData: "not-json" }
      : snapshot)),
  ];

  for (const mutate of mutations) {
    const report = validReport();
    report.avantrackingMigrationSnapshots = mutate(report.avantrackingMigrationSnapshots);
    const plan = buildRepairPlan(report);
    const client = new StatefulRepairClient(plan);
    const before = structuredClone(client.state);

    await assert.rejects(() => executeRepair(client, plan), /migration|Avantracking|evidencia|snapshot/i);
    assert.deepEqual(client.state, before);
  }
});

test("shared evidence hashes exact JSONB text without losing large-integer precision", async () => {
  async function hashFor(rawInteger) {
    const plan = buildRepairPlan(validReport());
    const client = new StatefulRepairClient(plan);
    client.sourceJsonbText.User = {
      "1": `{"id":1,"large":${rawInteger}}`,
    };
    await executeRepair(client, plan);
    return client.state.quarantine.manifest.recovery.sharedSnapshotEvidence
      .find(({ sourceTable }) => sourceTable === "User").contentSha256;
  }

  assert.notEqual(await hashFor("9007199254740992"), await hashFor("9007199254740993"));
});

test("executeRepair reads back and rejects a changed manifest before commit", async () => {
  const plan = buildRepairPlan(validReport());
  const client = new StatefulRepairClient(plan);
  const before = structuredClone(client.state);
  client.tamperManifestOnRead = true;

  await assert.rejects(() => executeRepair(client, plan), /manifest/i);

  assert.deepEqual(client.state, before);
  assert.equal(client.queries.at(-1).sql, "ROLLBACK");
});

test("fully repaired reports produce successful dry-run and apply no-ops", async () => {
  const firstPlan = buildRepairPlan(validReport());
  const client = new StatefulRepairClient(firstPlan);
  await executeRepair(client, firstPlan);
  const report = repairedReport(client.state.quarantine.manifest);
  const rerunPlan = buildRepairPlan(report);

  assert.equal(rerunPlan.length, 0);
  assert.equal(rerunPlan.repairContext.noOp, true);
  assert.deepEqual(await executeRepair(client, rerunPlan), {
    committed: true,
    noOp: true,
    operationCount: 0,
    movedTableCount: 0,
    quarantinedMigrationCount: 11,
  });

  let executeCalls = 0;
  const pools = [
    { async connect() { return { release() {} }; }, async end() {} },
    { async connect() { return { release() {} }; }, async end() {} },
  ];
  const summary = await runPreflight({
    shopeeDatabaseUrl: "postgresql://user:secret@shopee.example/shopee",
    avantrackingDatabaseUrl: "postgresql://user:secret@avantracking.example/avantracking",
    expectedFingerprint: report.shopeeTarget.fingerprint,
    apply: true,
  }, {
    createPool: () => pools.shift(),
    inspect: async () => report,
    execute: async () => { executeCalls += 1; },
  });

  assert.equal(executeCalls, 0);
  assert.equal(summary.writeMode, true);
  assert.equal(summary.noOp, true);
  assert.equal(summary.committed, true);

  const dryPools = [
    { async connect() { return { release() {} }; }, async end() {} },
    { async connect() { return { release() {} }; }, async end() {} },
  ];
  const drySummary = await runPreflight({
    shopeeDatabaseUrl: "postgresql://user:secret@shopee.example/shopee",
    avantrackingDatabaseUrl: "postgresql://user:secret@avantracking.example/avantracking",
    expectedFingerprint: report.shopeeTarget.fingerprint,
  }, {
    createPool: () => dryPools.shift(),
    inspect: async () => report,
    execute: async () => { executeCalls += 1; },
  });
  assert.equal(executeCalls, 0);
  assert.deepEqual(
    { writeMode: drySummary.writeMode, committed: drySummary.committed, noOp: drySummary.noOp },
    { writeMode: false, committed: true, noOp: true },
  );
});

test("preflight rejects a partial or inconsistent repaired state", () => {
  const report = repairedReport({});
  report.repairState = { status: "partial", reason: "manifest snapshot count mismatch" };

  assert.throws(
    () => validatePreflight(report, report.shopeeTarget.fingerprint),
    /reparo.*parcial|inconsistente/i,
  );
});

test("runPreflight keeps dry-run read-only and executes a repair only with apply", async () => {
  const report = validReport();
  const released = [];
  const ended = [];
  const clients = [
    { release() { released.push("shopee"); } },
    { release() { released.push("avantracking"); } },
  ];
  const pools = [
    { async connect() { return clients[0]; }, async end() { ended.push("shopee"); } },
    { async connect() { return clients[1]; }, async end() { ended.push("avantracking"); } },
  ];
  let executeCalls = 0;

  const summary = await runPreflight({
    shopeeDatabaseUrl: "postgresql://user:secret@shopee.example/shopee",
    avantrackingDatabaseUrl: "postgresql://user:secret@avantracking.example/avantracking",
    expectedFingerprint: report.shopeeTarget.fingerprint,
  }, {
    createPool: () => pools.shift(),
    inspect: async () => report,
    execute: async () => { executeCalls += 1; },
  });

  assert.equal(summary.writeMode, false);
  assert.equal(executeCalls, 0);
  assert.deepEqual(released.sort(), ["avantracking", "shopee"]);
  assert.deepEqual(ended.sort(), ["avantracking", "shopee"]);

  const applyPools = [
    { async connect() { return { release() {} }; }, async end() {} },
    { async connect() { return { release() {} }; }, async end() {} },
  ];
  const applySummary = await runPreflight({
    shopeeDatabaseUrl: "postgresql://user:secret@shopee.example/shopee",
    avantrackingDatabaseUrl: "postgresql://user:secret@avantracking.example/avantracking",
    expectedFingerprint: report.shopeeTarget.fingerprint,
    apply: true,
  }, {
    createPool: () => applyPools.shift(),
    inspect: async () => report,
    execute: async (_client, plan) => {
      executeCalls += 1;
      return {
        committed: true,
        operationCount: plan.length,
        movedTableCount: AVANTRACKING_ONLY_TABLES.length,
        quarantinedMigrationCount: MISPLACED_MIGRATIONS.length,
      };
    },
  });

  assert.equal(applySummary.writeMode, true);
  assert.equal(applySummary.committed, true);
  assert.equal(executeCalls, 1);
});

test("Avantracking target loader refuses a generic database URL", () => {
  assert.throws(
    () => loadAvantrackingDatabaseUrl({ DATABASE_URL: "postgresql://generic-only/db" }, []),
    /AVANTRACKING_DATABASE_URL/i,
  );
});

test("verified TLS modes retain certificate verification", () => {
  assert.deepEqual(
    resolveSslOptions("postgresql://database.example/app?sslmode=verify-ca"),
    { rejectUnauthorized: true },
  );
  assert.deepEqual(
    resolveSslOptions("postgresql://database.example/app?sslmode=verify-full"),
    { rejectUnauthorized: true },
  );
  assert.deepEqual(
    resolveSslOptions("postgresql://database.neon.tech/app?sslmode=verify-full"),
    { rejectUnauthorized: true },
  );
});

test("preflight releases acquired resources when the second connection fails", async () => {
  let shopeeReleased = 0;
  let shopeePoolEnded = 0;
  let avantrackingPoolEnded = 0;
  const shopeePool = {
    async connect() {
      return { release() { shopeeReleased += 1; } };
    },
    async end() { shopeePoolEnded += 1; },
  };
  const avantrackingPool = {
    async connect() { throw new Error("Avantracking connection failed"); },
    async end() { avantrackingPoolEnded += 1; },
  };
  const pools = [shopeePool, avantrackingPool];

  await assert.rejects(
    () => runPreflight({
      shopeeDatabaseUrl: "postgresql://user:secret@shopee.example/shopee",
      avantrackingDatabaseUrl: "postgresql://user:secret@avantracking.example/avantracking",
      expectedFingerprint: "unused-after-connection-failure",
    }, {
      createPool: () => pools.shift(),
    }),
    /Avantracking connection failed/,
  );

  assert.equal(shopeeReleased, 1);
  assert.equal(shopeePoolEnded, 1);
  assert.equal(avantrackingPoolEnded, 1);
});
