"use strict";

const crypto = require("node:crypto");

const REPAIR_ADVISORY_LOCK = 736846420260811;
const QUARANTINE_SCHEMA = "quarantine_avantracking_20260811";
const REPAIR_MANIFEST_FORMAT = "davantti-shopee-avantracking-repair";
const REPAIR_MANIFEST_VERSION = 3;

const MISPLACED_MIGRATIONS = Object.freeze([
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
]);

const AVANTRACKING_ONLY_TABLES = Object.freeze([
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

const SHARED_CONTAMINATED_COLUMNS = Object.freeze({
  User: Object.freeze([
    "password",
    "companyId",
    "phone",
    "birthDate",
    "profileImageData",
    "lastBirthdayCelebrationAt",
  ]),
  Order: Object.freeze([
    "orderNumber", "invoiceNumber", "trackingCode", "customerName", "corporateName", "cpf", "cnpj",
    "phone", "mobile", "salesChannel", "freightType", "freightValue", "quotedFreightValue",
    "quotedFreightDate", "quotedFreightDetails", "originalQuotedFreightValue", "originalQuotedFreightDate",
    "originalQuotedFreightDetails", "originalQuotedFreightQuotationId", "recalculatedFreightValue",
    "recalculatedFreightDate", "recalculatedFreightDetails", "shippingDate", "address", "number",
    "complement", "neighborhood", "city", "state", "zipCode", "totalValue", "recipient",
    "maxShippingDeadline", "estimatedDeliveryDate", "carrierEstimatedDeliveryDate", "status", "isDelayed",
    "isArchived", "archivedAt", "manualCustomStatus", "observation", "lastApiSync", "lastUpdate",
    "lastApiError", "apiRawPayload", "carrierId", "createdById", "companyId",
  ]),
  ReleaseNote: Object.freeze(["sentByUserId"]),
});

const KNOWN_CONTAMINATED_FK_TUPLES = Object.freeze([
  Object.freeze(["LogisyncUser_companyId_fkey", "LogisyncUser", "companyId", "Company", "id"]),
  Object.freeze(["MonitoredOrder_companyId_fkey", "MonitoredOrder", "companyId", "Company", "id"]),
  Object.freeze(["MonitoredOrder_createdById_fkey", "MonitoredOrder", "createdById", "User", "id"]),
  Object.freeze(["Order_carrierId_fkey", "Order", "carrierId", "Carrier", "id"]),
  Object.freeze(["Order_companyId_fkey", "Order", "companyId", "Company", "id"]),
  Object.freeze(["Order_createdById_fkey", "Order", "createdById", "User", "id"]),
  Object.freeze(["SyncNotification_companyId_fkey", "SyncNotification", "companyId", "Company", "id"]),
  Object.freeze(["TrayAuth_companyId_fkey", "TrayAuth", "companyId", "Company", "id"]),
  Object.freeze(["TrayCheckoutQuote_companyIdValue_fkey", "TrayCheckoutQuote", "companyIdValue", "Company", "id"]),
  Object.freeze(["TrayCheckoutQuote_companyId_fkey", "TrayCheckoutQuote", "companyId", "Company", "id"]),
  Object.freeze(["User_companyId_fkey", "User", "companyId", "Company", "id"]),
  Object.freeze(["UserAccessToken_userId_fkey", "UserAccessToken", "userId", "User", "id"]),
]);

const KNOWN_CONTAMINATED_FKS = new Set(KNOWN_CONTAMINATED_FK_TUPLES.map(([constraintName]) => constraintName));

const CANONICAL_SHOPEE_USER_FK_TUPLES = Object.freeze([
  Object.freeze(["Session_userId_fkey", "Session", "userId", "User", "id"]),
  Object.freeze(["Session_realUserId_fkey", "Session", "realUserId", "User", "id"]),
  Object.freeze(["ListingCloneDraft_userId_fkey", "ListingCloneDraft", "userId", "User", "id"]),
  Object.freeze(["ProductBoostBatch_userId_fkey", "ProductBoostBatch", "userId", "User", "id"]),
  Object.freeze(["AuthAudit_userId_fkey", "AuthAudit", "userId", "User", "id"]),
  Object.freeze(["OAuthState_userId_fkey", "OAuthState", "userId", "User", "id"]),
]);

const SHARED_TABLES = Object.freeze(Object.keys(SHARED_CONTAMINATED_COLUMNS));
const AFFECTED_SOURCE_TABLES = Object.freeze([
  ...SHARED_TABLES,
  ...AVANTRACKING_ONLY_TABLES,
  "_davantti_sql_migrations",
]);
const CANONICAL_SHARED_COLUMNS = Object.freeze([
  Object.freeze(["User", "id"]),
  Object.freeze(["User", "userGlobalId"]),
  Object.freeze(["User", "accountId"]),
  Object.freeze(["Order", "id"]),
  Object.freeze(["Order", "orderSn"]),
  Object.freeze(["Order", "orderStatus"]),
  Object.freeze(["Order", "actualShippingFeeCents"]),
  Object.freeze(["Order", "commFeeCents"]),
  Object.freeze(["Order", "escrowAmountCents"]),
  Object.freeze(["Order", "serviceFeeCents"]),
  Object.freeze(["Order", "totalAmountCents"]),
  Object.freeze(["Order", "transactionFeeCents"]),
  Object.freeze(["ReleaseNote", "id"]),
]);
const CRITICAL_COLUMNS = Object.freeze([
  ["User", "id"],
  ["Order", "id"],
  ["Order", "createdById"],
  ["ReleaseNote", "sentByUserId"],
  ["UserAccessToken", "userId"],
  ["MonitoredOrder", "createdById"],
  ["CompanyOrderCustomStatus", "createdById"],
]);
const REPAIR_OPERATION_KINDS = Object.freeze([
  "sql:acquire-advisory-lock",
  "action:reinspect-repair-state-after-advisory",
  "action:refresh-lock-revalidate-source-inventory",
  "sql:validate-current-foreign-keys",
  "sql:capture-locked-source-row-counts",
  "sql:capture-locked-migration-snapshot-evidence",
  "sql:capture-locked-shared-evidence-User",
  "sql:capture-locked-shared-evidence-Order",
  "sql:capture-locked-shared-evidence-ReleaseNote",
  "sql:create-quarantine-schema",
  "sql:create-repair-manifest-table",
  "sql:create-migration-history-table",
  "sql:create-shared-row-snapshots-table",
  "sql:write-repair-manifest",
  "sql:snapshot-migration-history",
  "sql:snapshot-shared-User",
  "sql:snapshot-shared-Order",
  "sql:snapshot-shared-ReleaseNote",
  "repeat:drop-observed-known-contaminated-fk",
  "repeat:move-observed-avantracking-table",
  "sql:drop-columns-User",
  "sql:drop-columns-Order",
  "sql:drop-columns-ReleaseNote",
  "sql:delete-misplaced-migration-history",
]);

function fingerprintObservedTarget(database, schema) {
  return crypto
    .createHash("sha256")
    .update(`observed|${database}|${schema}`)
    .digest("hex")
    .slice(0, 12);
}

function targetForClient(client, observedTarget) {
  const configuredTarget = client.databaseTarget || {};
  const fingerprint = String(configuredTarget.fingerprint || "").trim()
    || fingerprintObservedTarget(observedTarget.database, observedTarget.schema);

  return Object.freeze({
    fingerprint,
    configuredDatabase: configuredTarget.database || null,
    configuredSchema: configuredTarget.schema || null,
    observedDatabase: observedTarget.database || null,
    observedSchema: observedTarget.schema || null,
  });
}

function quotedPublicTable(tableName) {
  if (!AVANTRACKING_ONLY_TABLES.includes(tableName)) {
    throw new Error(`Tabela fora do inventario permitido: ${tableName}`);
  }
  return `"public"."${tableName}"`;
}

async function inspectTarget(client) {
  const result = await client.query(`
    SELECT current_database() AS database, current_schema() AS schema
  `);
  const row = result.rows[0] || {};
  return targetForClient(client, row);
}

async function inspectMigrationHistory(client) {
  const result = await client.query(`
    SELECT name
    FROM "public"."_davantti_sql_migrations"
    ORDER BY name
  `);
  return new Set(result.rows.map((row) => String(row.name)));
}

async function inspectReferenceMigrationSnapshots(client) {
  const result = await client.query(`
    /* Avantracking reference migration snapshots */
    SELECT history_row."name", to_jsonb(history_row)::text AS "rowData"
    FROM "public"."_davantti_sql_migrations" AS history_row
    WHERE history_row."name" = ANY($1::text[])
    ORDER BY history_row."name"
  `, [MISPLACED_MIGRATIONS]);
  return validateMigrationSnapshots(result.rows);
}

async function inspectActiveAvantrackingObjects(client) {
  const result = await client.query(`
    /* pg_class object inventory */
    SELECT c.relname AS "tableName"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname = ANY($1)
    ORDER BY c.relname
  `, [AVANTRACKING_ONLY_TABLES]);
  return result.rows.map((row) => String(row.tableName));
}

async function inspectAffectedSourceTables(client) {
  const result = await client.query(`
    /* affected source table inventory */
    SELECT c.relname AS "tableName"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname = ANY($1::text[])
    ORDER BY array_position($1::text[], c.relname)
  `, [AFFECTED_SOURCE_TABLES]);
  const observed = new Set(result.rows.map((row) => String(row.tableName)));
  const ordered = AFFECTED_SOURCE_TABLES.filter((tableName) => observed.has(tableName));
  if (ordered.length !== observed.size) throw new Error("Inventario de tabelas afetadas invalido.");
  for (const requiredTable of [...SHARED_TABLES, "_davantti_sql_migrations"]) {
    if (!observed.has(requiredTable)) {
      throw new Error(`Tabela de origem obrigatoria ausente: ${requiredTable}.`);
    }
  }
  return ordered;
}

function affectedSourceLockSql(tableNames) {
  if (!Array.isArray(tableNames) || !tableNames.length
    || tableNames.some((tableName) => !AFFECTED_SOURCE_TABLES.includes(tableName))) {
    throw new Error("Inventario de lock de origem invalido.");
  }
  return `LOCK TABLE ${tableNames.map((tableName) => `"public"."${tableName}"`).join(", ")} IN ACCESS EXCLUSIVE MODE`;
}

async function inspectTableRowCounts(client, tableNames) {
  const counts = new Map();
  for (const tableName of tableNames) {
    const result = await client.query(`
      /* row count for Avantracking-only table */
      SELECT COUNT(*)::bigint AS count
      FROM ${quotedPublicTable(tableName)}
    `);
    counts.set(tableName, Number(result.rows[0]?.count || 0));
  }
  return counts;
}

async function inspectForeignKeys(client) {
  const relevantTables = [...new Set([...AVANTRACKING_ONLY_TABLES, ...SHARED_TABLES])];
  const result = await client.query(`
    /* pg_constraint foreign keys */
    SELECT
      con.conname AS "constraintName",
      src.relname AS "sourceTable",
      src_att.attname AS "sourceColumn",
      tgt.relname AS "targetTable",
      tgt_att.attname AS "targetColumn"
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
    JOIN pg_class tgt ON tgt.oid = con.confrelid
    JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
    JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS src_key(attnum, position) ON true
    JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS tgt_key(attnum, position)
      ON tgt_key.position = src_key.position
    JOIN pg_attribute src_att ON src_att.attrelid = src.oid AND src_att.attnum = src_key.attnum
    JOIN pg_attribute tgt_att ON tgt_att.attrelid = tgt.oid AND tgt_att.attnum = tgt_key.attnum
    WHERE con.contype = 'f'
      AND src_ns.nspname = 'public'
      AND tgt_ns.nspname = 'public'
      AND (
        src.relname = ANY($1)
        OR tgt.relname = ANY($1)
        OR tgt.relname = 'User'
      )
    ORDER BY con.conname, src_key.position
  `, [relevantTables]);
  return result.rows.map((row) => ({
    constraintName: String(row.constraintName),
    sourceTable: String(row.sourceTable),
    sourceColumn: String(row.sourceColumn),
    targetTable: String(row.targetTable),
    targetColumn: String(row.targetColumn),
  }));
}

async function inspectCriticalColumnTypes(client) {
  const result = await client.query(`
    /* information_schema critical columns */
    SELECT
      table_name AS "tableName",
      column_name AS "columnName",
      udt_name AS "udtName"
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY($1)
    ORDER BY table_name, column_name
  `, [[...new Set([...SHARED_TABLES, ...AVANTRACKING_ONLY_TABLES])]]);

  const allowed = new Set(CRITICAL_COLUMNS.map(([tableName, columnName]) => `${tableName}.${columnName}`));
  return result.rows
    .filter((row) => allowed.has(`${row.tableName}.${row.columnName}`))
    .map((row) => ({
      tableName: String(row.tableName),
      columnName: String(row.columnName),
      udtName: String(row.udtName),
    }));
}

async function inspectNonNumericUserIds(client) {
  const result = await client.query(`
    /* non-numeric User ids */
    SELECT COUNT(*)::bigint AS count
    FROM "User"
    WHERE "id"::text !~ '^[0-9]+$'
  `);
  return Number(result.rows[0]?.count || 0);
}

function partialRepairState(reason) {
  return { status: "partial", reason };
}

function exactStringSet(actualValues, expectedValues) {
  const actual = [...new Set(actualValues.map(String))].sort();
  const expected = [...new Set(expectedValues.map(String))].sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function manifestWithoutDigest(manifest) {
  const copy = structuredClone(manifest);
  delete copy.evidenceSha256;
  return copy;
}

function hasValidManifestDigest(manifest) {
  return typeof manifest?.evidenceSha256 === "string"
    && /^[a-f0-9]{64}$/.test(manifest.evidenceSha256)
    && sha256(stableJson(manifestWithoutDigest(manifest))) === manifest.evidenceSha256;
}

function staticRepairEvidence() {
  return {
    dynamicEvidenceBoundary: "Detects corruption and inconsistent snapshots; without an external signing key it cannot authenticate evidence rewritten by a database administrator.",
    misplacedMigrationNames: [...MISPLACED_MIGRATIONS],
    knownContaminatedForeignKeyTuples: KNOWN_CONTAMINATED_FK_TUPLES.map((tuple) => [...tuple]),
    sharedContaminatedColumns: SHARED_TABLES.map((tableName) => ({
      tableName,
      columns: [...SHARED_CONTAMINATED_COLUMNS[tableName]],
    })),
    canonicalColumns: CANONICAL_SHARED_COLUMNS.map((tuple) => [...tuple]),
    operationKinds: [...REPAIR_OPERATION_KINDS],
  };
}

async function inspectRepairObjects(client) {
  const result = await client.query(`
    /* repair state objects */
    SELECT
      to_regnamespace($1) IS NOT NULL AS "schemaExists",
      to_regclass($2) IS NOT NULL AS "manifestTableExists",
      to_regclass($3) IS NOT NULL AS "migrationHistoryTableExists",
      to_regclass($4) IS NOT NULL AS "sharedSnapshotsTableExists"
  `, [
    QUARANTINE_SCHEMA,
    `${QUARANTINE_SCHEMA}.repair_manifest`,
    `${QUARANTINE_SCHEMA}.migration_history`,
    `${QUARANTINE_SCHEMA}.shared_row_snapshots`,
  ]);
  return result.rows[0] || {};
}

async function inspectRepairState(client, report, inspectedObjects) {
  const objects = inspectedObjects || await inspectRepairObjects(client);
  const objectFlags = [
    objects.schemaExists,
    objects.manifestTableExists,
    objects.migrationHistoryTableExists,
    objects.sharedSnapshotsTableExists,
  ].map(Boolean);
  if (objectFlags.every((exists) => !exists)) return { status: "not-repaired" };
  if (!objectFlags.every(Boolean)) return partialRepairState("objetos de quarentena incompletos");

  const manifestResult = await client.query(`
    /* repair state manifest */
    SELECT "snapshot"
    FROM "${QUARANTINE_SCHEMA}"."repair_manifest"
    WHERE "key" = $1
  `, ["repair-plan"]);
  if (manifestResult.rows.length !== 1) return partialRepairState("manifesto ausente ou duplicado");
  const manifest = manifestResult.rows[0].snapshot;
  if (!manifest || manifest.format !== REPAIR_MANIFEST_FORMAT
    || manifest.version !== REPAIR_MANIFEST_VERSION
    || manifest.advisoryLock !== REPAIR_ADVISORY_LOCK
    || manifest.quarantineSchema !== QUARANTINE_SCHEMA
    || !manifest.sourceRowCounts
    || !Array.isArray(manifest.operations)
    || !manifest.recovery
    || !hasValidManifestDigest(manifest)) {
    return partialRepairState("manifesto invalido");
  }

  const activeTables = manifest.recovery.activeAvantrackingObjects;
  const observedForeignKeys = manifest.recovery.observedForeignKeys;
  const sourceMigrationNames = manifest.recovery.sourceMigrationNames;
  const unrelatedMigrationNames = manifest.recovery.unrelatedMigrationNames;
  const migrationSnapshots = manifest.recovery.migrationSnapshots;
  const sharedSnapshotEvidence = manifest.recovery.sharedSnapshotEvidence;
  const expectedManifestKeys = [
    "advisoryLock", "evidenceSha256", "format", "operations", "quarantineSchema",
    "recovery", "sourceRowCounts", "staticEvidence", "version",
  ];
  const expectedRecoveryKeys = [
    "activeAvantrackingObjects", "contaminatedForeignKeys", "lockedSourceTables",
    "migrationSnapshots", "observedForeignKeys", "sharedSnapshotEvidence",
    "sourceMigrationNames", "unrelatedMigrationNames",
  ];
  if (!exactStringSet(Object.keys(manifest), expectedManifestKeys)
    || !exactStringSet(Object.keys(manifest.recovery), expectedRecoveryKeys)
    || !Array.isArray(activeTables)
    || activeTables.some((tableName) => !AVANTRACKING_ONLY_TABLES.includes(tableName))
    || !Array.isArray(observedForeignKeys)
    || !Array.isArray(sourceMigrationNames)
    || !Array.isArray(unrelatedMigrationNames)
    || !Array.isArray(migrationSnapshots)
    || !Array.isArray(sharedSnapshotEvidence)
    || stableJson(manifest.staticEvidence) !== stableJson(staticRepairEvidence())) {
    return partialRepairState("metadados de recuperacao invalidos");
  }

  const expectedUnrelatedNames = sourceMigrationNames
    .filter((name) => !MISPLACED_MIGRATIONS.includes(name))
    .map(String)
    .sort();
  const lockedSourceTables = manifest.recovery.lockedSourceTables;
  const expectedLockedSourceTables = AFFECTED_SOURCE_TABLES.filter((tableName) => (
    SHARED_TABLES.includes(tableName)
    || activeTables.includes(tableName)
    || tableName === "_davantti_sql_migrations"
  ));
  const expectedCountKeys = [...expectedLockedSourceTables, "_davantti_sql_migrations:misplaced"];
  if (!exactStringSet(Object.keys(manifest.sourceRowCounts), expectedCountKeys)
    || stableJson(lockedSourceTables) !== stableJson(expectedLockedSourceTables)
    || Object.values(manifest.sourceRowCounts).some(
      (count) => !Number.isSafeInteger(count) || count < 0,
    )
    || manifest.sourceRowCounts["_davantti_sql_migrations:misplaced"] !== MISPLACED_MIGRATIONS.length
    || manifest.sourceRowCounts._davantti_sql_migrations !== sourceMigrationNames.length
    || !exactStringSet(unrelatedMigrationNames, expectedUnrelatedNames)
    || !exactStringSet(sourceMigrationNames, [...MISPLACED_MIGRATIONS, ...unrelatedMigrationNames])) {
    return partialRepairState("contagens ou migrations de origem invalidas");
  }

  try {
    validateMigrationSnapshots(migrationSnapshots);
    validateExternalMigrationReference(
      migrationSnapshots,
      report.avantrackingMigrationSnapshots,
    );
  } catch (error) {
    return partialRepairState(error.message);
  }
  if (sharedSnapshotEvidence.length !== SHARED_TABLES.length
    || sharedSnapshotEvidence.some((entry, index) => (
      entry.sourceTable !== SHARED_TABLES[index]
      || entry.rowCount !== manifest.sourceRowCounts[entry.sourceTable]
      || !/^[a-f0-9]{64}$/.test(entry.contentSha256)
      || !exactStringSet(Object.keys(entry), ["sourceTable", "rowCount", "contentSha256"])
    ))) {
    return partialRepairState("evidencia dos snapshots compartilhados invalida");
  }

  try {
    const sourceReport = {
      activeAvantrackingObjects: activeTables,
      foreignKeys: observedForeignKeys,
      shopeeAppliedMigrations: new Set(sourceMigrationNames),
    };
    const reconstructedPlan = buildRepairPlan(sourceReport);
    if (stableJson(operationKindsForPlan(reconstructedPlan)) !== stableJson(REPAIR_OPERATION_KINDS)) {
      return partialRepairState("ordem estatica das operacoes diverge do codigo aprovado");
    }
    if (stableJson(serializedRepairOperations(reconstructedPlan)) !== stableJson(manifest.operations)) {
      return partialRepairState("lista de operacoes do manifesto diverge do plano deterministico");
    }
    if (stableJson(reconstructedPlan.repairContext.contaminatedForeignKeys)
      !== stableJson(manifest.recovery.contaminatedForeignKeys)
      || stableJson(reconstructedPlan.repairContext.observedForeignKeys)
        !== stableJson(manifest.recovery.observedForeignKeys)
      || stableJson(reconstructedPlan.repairContext.activeAvantrackingObjects)
        !== stableJson(activeTables)) {
      return partialRepairState("inventario de origem do manifesto diverge");
    }
  } catch (error) {
    return partialRepairState(`manifesto nao reconstrutivel: ${error.message}`);
  }

  const tableResult = await client.query(`
    /* repair state table locations */
    SELECT table_name AS "tableName", table_schema AS "tableSchema"
    FROM information_schema.tables
    WHERE table_schema = ANY($1::text[])
      AND table_name = ANY($2::text[])
    ORDER BY table_schema, table_name
  `, [["public", QUARANTINE_SCHEMA], AVANTRACKING_ONLY_TABLES]);
  const publicTables = tableResult.rows
    .filter((row) => row.tableSchema === "public")
    .map((row) => row.tableName);
  const quarantinedTables = tableResult.rows
    .filter((row) => row.tableSchema === QUARANTINE_SCHEMA)
    .map((row) => row.tableName);
  if (publicTables.length || !exactStringSet(quarantinedTables, activeTables)) {
    return partialRepairState("localizacao das tabelas Avantracking diverge do manifesto");
  }

  const forbiddenForeignKeyResult = await client.query(`
    /* repair state forbidden foreign keys */
    SELECT
      con.conname AS "constraintName",
      src_ns.nspname AS "sourceSchema",
      tgt_ns.nspname AS "targetSchema"
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
    JOIN pg_class tgt ON tgt.oid = con.confrelid
    JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
    WHERE con.contype = 'f'
      AND (
        con.conname = ANY($1::text[])
        OR (
          (src_ns.nspname = $2 OR tgt_ns.nspname = $2)
          AND src_ns.nspname <> tgt_ns.nspname
        )
      )
    ORDER BY con.conname
  `, [[...KNOWN_CONTAMINATED_FKS], QUARANTINE_SCHEMA]);
  if (forbiddenForeignKeyResult.rows.length) {
    return partialRepairState(
      `foreign key proibida ainda presente: ${forbiddenForeignKeyResult.rows[0].constraintName}`,
    );
  }

  const migrationSnapshotResult = await client.query(`
    /* repair state migration snapshots */
    SELECT "name", "snapshot"::text AS "rowData"
    FROM "${QUARANTINE_SCHEMA}"."migration_history"
    ORDER BY "name"
  `);
  if (!exactStringSet(migrationSnapshotResult.rows.map((row) => row.name), MISPLACED_MIGRATIONS)
    || stableJson(normalizedMigrationSnapshots(migrationSnapshotResult.rows))
      !== stableJson(normalizedMigrationSnapshots(migrationSnapshots))) {
    return partialRepairState("snapshots de migration incompletos");
  }

  const sharedSnapshotResult = await client.query(`
    /* repair state shared snapshot evidence */
    SELECT "source_table" AS "sourceTable", "original_id" AS "originalId",
      "snapshot"::text AS "rowData"
    FROM "${QUARANTINE_SCHEMA}"."shared_row_snapshots"
    ORDER BY "source_table", "original_id"
  `);
  const observedSharedEvidence = sharedEvidenceFromRows(sharedSnapshotResult.rows);
  for (const tableName of SHARED_TABLES) {
    const observed = observedSharedEvidence.find((entry) => entry.sourceTable === tableName);
    const expected = sharedSnapshotEvidence.find((entry) => entry.sourceTable === tableName);
    if (!observed || !expected || stableJson(observed) !== stableJson(expected)
      || observed.rowCount !== manifest.sourceRowCounts[tableName]) {
      return partialRepairState(`contagem do snapshot compartilhado diverge: ${tableName}`);
    }
  }

  if (activeTables.length) {
    const countSelects = activeTables.map((tableName, index) => `
      SELECT $${index + 1}::text AS "sourceTable", COUNT(*)::bigint AS "rowCount"
      FROM "${QUARANTINE_SCHEMA}"."${tableName}"
    `);
    const sourceCountResult = await client.query(`
      /* repair state source row counts */
      ${countSelects.join(" UNION ALL ")}
    `, activeTables);
    const sourceCounts = new Map(
      sourceCountResult.rows.map((row) => [String(row.sourceTable), Number(row.rowCount)]),
    );
    if (sourceCountResult.rows.length !== activeTables.length
      || sourceCounts.size !== activeTables.length) {
      return partialRepairState("inventario de contagens em quarentena diverge");
    }
    for (const tableName of activeTables) {
      if (sourceCounts.get(tableName) !== manifest.sourceRowCounts[tableName]) {
        return partialRepairState(`contagem da tabela em quarentena diverge: ${tableName}`);
      }
    }
  }

  const sharedColumnResult = await client.query(`
    /* repair state shared columns */
    SELECT table_name AS "tableName", column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
    ORDER BY table_name, ordinal_position
  `, [SHARED_TABLES]);
  const sharedColumns = new Set(
    sharedColumnResult.rows.map((row) => `${row.tableName}.${row.columnName}`),
  );
  for (const tableName of SHARED_TABLES) {
    if (SHARED_CONTAMINATED_COLUMNS[tableName].some(
      (columnName) => sharedColumns.has(`${tableName}.${columnName}`),
    )) return partialRepairState(`coluna contaminada ainda presente em ${tableName}`);
  }
  if (CANONICAL_SHARED_COLUMNS.some(
    ([tableName, columnName]) => !sharedColumns.has(`${tableName}.${columnName}`),
  )) return partialRepairState("coluna canonica ausente");

  if (MISPLACED_MIGRATIONS.some((name) => report.shopeeAppliedMigrations.has(name))) {
    return partialRepairState("migration contaminada ainda ativa");
  }
  if (unrelatedMigrationNames.some((name) => !report.shopeeAppliedMigrations.has(name))) {
    return partialRepairState("migration nao relacionada ausente");
  }
  if ((report.activeAvantrackingObjects || []).length) {
    return partialRepairState("tabela Avantracking ainda ativa em public");
  }
  if ((report.foreignKeys || []).some(isUnknownExternalForeignKey)
    || (report.foreignKeys || []).some(({ constraintName }) => KNOWN_CONTAMINATED_FKS.has(constraintName))) {
    return partialRepairState("foreign key contaminada ou desconhecida ainda ativa");
  }

  return { status: "repaired", manifest };
}

async function inspectContamination(shopeeClient, avantrackingClient) {
  const [
    shopeeTarget,
    avantrackingTarget,
    shopeeAppliedMigrations,
    avantrackingAppliedMigrations,
    activeAvantrackingObjects,
    foreignKeys,
    criticalColumnTypes,
    nonNumericUserIdCount,
    avantrackingMigrationSnapshots,
  ] = await Promise.all([
    inspectTarget(shopeeClient),
    inspectTarget(avantrackingClient),
    inspectMigrationHistory(shopeeClient),
    inspectMigrationHistory(avantrackingClient),
    inspectActiveAvantrackingObjects(shopeeClient),
    inspectForeignKeys(shopeeClient),
    inspectCriticalColumnTypes(shopeeClient),
    inspectNonNumericUserIds(shopeeClient),
    inspectReferenceMigrationSnapshots(avantrackingClient),
  ]);

  const tableRowCounts = await inspectTableRowCounts(shopeeClient, activeAvantrackingObjects);

  const report = {
    shopeeTarget,
    avantrackingTarget,
    shopeeAppliedMigrations,
    avantrackingAppliedMigrations,
    activeAvantrackingObjects,
    tableRowCounts,
    foreignKeys,
    criticalColumnTypes,
    nonNumericUserIdCount,
    avantrackingMigrationSnapshots,
  };
  report.repairState = await inspectRepairState(shopeeClient, report);
  return report;
}

async function inspectCurrentRepairState(client, avantrackingMigrationSnapshots = []) {
  const objects = await inspectRepairObjects(client);
  const objectFlags = [
    objects.schemaExists,
    objects.manifestTableExists,
    objects.migrationHistoryTableExists,
    objects.sharedSnapshotsTableExists,
  ].map(Boolean);
  if (objectFlags.every((exists) => !exists)) {
    return { repairState: { status: "not-repaired" } };
  }
  if (!objectFlags.every(Boolean)) {
    return { repairState: partialRepairState("objetos de quarentena incompletos") };
  }
  const shopeeAppliedMigrations = await inspectMigrationHistory(client);
  const activeAvantrackingObjects = await inspectActiveAvantrackingObjects(client);
  const foreignKeys = await inspectForeignKeys(client);
  const criticalColumnTypes = await inspectCriticalColumnTypes(client);
  const nonNumericUserIdCount = await inspectNonNumericUserIds(client);
  const tableRowCounts = await inspectTableRowCounts(client, activeAvantrackingObjects);
  const report = {
    shopeeAppliedMigrations,
    activeAvantrackingObjects,
    foreignKeys,
    criticalColumnTypes,
    nonNumericUserIdCount,
    tableRowCounts,
    avantrackingMigrationSnapshots,
  };
  report.repairState = await inspectRepairState(client, report, objects);
  return report;
}

function validateRepairPlanBlueprint(plan) {
  if (stableJson(operationKindsForPlan(plan)) !== stableJson(REPAIR_OPERATION_KINDS)) {
    throw new Error("Ordem estatica do plano de reparo diverge do blueprint deterministico.");
  }
  if (plan[0]?.name !== "acquire-advisory-lock"
    || normalizedOperationSql(plan[0]?.sql) !== `SELECT pg_advisory_xact_lock(${REPAIR_ADVISORY_LOCK})`
    || plan[1]?.name !== "reinspect-repair-state-after-advisory"
    || plan[1]?.action !== "reinspectRepairState"
    || plan[2]?.name !== "refresh-lock-revalidate-source-inventory"
    || plan[2]?.action !== "refreshLockRevalidateSourceInventory") {
    throw new Error("Prefixo de advisory lock e inventario do plano de reparo invalido.");
  }
}

function dynamicRepairContextMatches(left, right) {
  const keys = [
    "activeAvantrackingObjects", "contaminatedForeignKeys", "observedForeignKeys",
    "lockedSourceTables", "sourceMigrationNames", "unrelatedMigrationNames",
  ];
  return keys.every((key) => stableJson(left[key]) === stableJson(right[key]));
}

async function buildLockedRepairPlan(client, originalContext) {
  const beforeLock = await inspectAffectedSourceTables(client);
  await client.query(affectedSourceLockSql(beforeLock));
  const underLock = await inspectAffectedSourceTables(client);
  if (stableJson(beforeLock) !== stableJson(underLock)) {
    throw new Error("Inventario de tabelas afetadas mudou durante o lock; tente novamente.");
  }

  const shopeeAppliedMigrations = await inspectMigrationHistory(client);
  if (!exactStringSet([...shopeeAppliedMigrations], originalContext.sourceMigrationNames)) {
    throw new Error("Historico de migrations mudou depois do preflight.");
  }
  const foreignKeys = await inspectForeignKeys(client);
  const refreshedPlan = buildRepairPlan({
    activeAvantrackingObjects: AVANTRACKING_ONLY_TABLES.filter((tableName) => underLock.includes(tableName)),
    foreignKeys,
    shopeeAppliedMigrations,
    avantrackingMigrationSnapshots: structuredClone(
      originalContext.avantrackingMigrationSnapshots || [],
    ),
  });
  if (stableJson(refreshedPlan.repairContext.lockedSourceTables) !== stableJson(underLock)) {
    throw new Error("Plano bloqueado diverge do inventario de tabelas afetadas.");
  }
  return refreshedPlan;
}

function foreignKeyMatchesTuple(foreignKey, tuple) {
  const [constraintName, sourceTable, sourceColumn, targetTable, targetColumn] = tuple;
  return foreignKey.constraintName === constraintName
    && foreignKey.sourceTable === sourceTable
    && foreignKey.sourceColumn === sourceColumn
    && foreignKey.targetTable === targetTable
    && foreignKey.targetColumn === targetColumn;
}

function hasForeignKeyTuple(foreignKey, tuples) {
  return tuples.some((tuple) => foreignKeyMatchesTuple(foreignKey, tuple));
}

function isUnknownExternalForeignKey(foreignKey) {
  const knownName = KNOWN_CONTAMINATED_FKS.has(foreignKey.constraintName);
  if (knownName && !hasForeignKeyTuple(foreignKey, KNOWN_CONTAMINATED_FK_TUPLES)) return true;

  const targetsUserId = foreignKey.targetTable === "User" && foreignKey.targetColumn === "id";
  if (
    targetsUserId
    && !hasForeignKeyTuple(foreignKey, KNOWN_CONTAMINATED_FK_TUPLES)
    && !hasForeignKeyTuple(foreignKey, CANONICAL_SHOPEE_USER_FK_TUPLES)
  ) {
    return true;
  }

  if (knownName) return false;

  const sourceIsAvantrackingOnly = AVANTRACKING_ONLY_TABLES.includes(foreignKey.sourceTable);
  const targetIsAvantrackingOnly = AVANTRACKING_ONLY_TABLES.includes(foreignKey.targetTable);
  return sourceIsAvantrackingOnly !== targetIsAvantrackingOnly;
}

function validateObservedTarget(label, target) {
  if (!target?.configuredDatabase && !target?.configuredSchema) return;
  if (!target.observedDatabase || !target.observedSchema) {
    throw new Error(`Identidade observada do banco ${label} esta ausente.`);
  }
  if (target.configuredDatabase && target.configuredDatabase !== target.observedDatabase) {
    throw new Error(`Banco observado do ${label} diverge do alvo configurado.`);
  }
  if (target.configuredSchema && target.configuredSchema !== target.observedSchema) {
    throw new Error(`Schema observado do ${label} diverge do alvo configurado.`);
  }
}

function missingMigrations(appliedMigrations) {
  const applied = appliedMigrations instanceof Set ? appliedMigrations : new Set(appliedMigrations || []);
  return MISPLACED_MIGRATIONS.filter((migration) => !applied.has(migration));
}

function validatePreflight(report, expectedFingerprint) {
  const expected = String(expectedFingerprint || "").trim();
  if (!expected) throw new Error("Fingerprint esperado do banco Shopee e obrigatorio.");
  validateObservedTarget("Shopee", report.shopeeTarget);
  validateObservedTarget("Avantracking", report.avantrackingTarget);
  if (report.shopeeTarget?.fingerprint !== expected) {
    throw new Error("Fingerprint do banco Shopee nao corresponde ao alvo esperado.");
  }
  if (report.shopeeTarget?.fingerprint === report.avantrackingTarget?.fingerprint) {
    throw new Error("Shopee e Avantracking apontam para o mesmo fingerprint de banco.");
  }

  const repairStatus = report.repairState?.status || "not-repaired";
  if (repairStatus === "partial") {
    throw new Error(`Reparo parcial ou inconsistente: ${report.repairState.reason || "estado desconhecido"}.`);
  }
  if (!new Set(["not-repaired", "repaired"]).has(repairStatus)) {
    throw new Error(`Estado de reparo desconhecido: ${repairStatus}.`);
  }

  const histories = [["Avantracking", report.avantrackingAppliedMigrations]];
  if (repairStatus === "not-repaired") histories.push(["Shopee", report.shopeeAppliedMigrations]);
  for (const [label, migrations] of histories) {
    const missing = missingMigrations(migrations);
    if (missing.length) {
      throw new Error(`Migration ausente no historico ${label}: ${missing.join(", ")}.`);
    }
  }

  const unknownForeignKey = (report.foreignKeys || []).find(isUnknownExternalForeignKey);
  if (unknownForeignKey) {
    throw new Error(
      `Foreign key externo desconhecido: ${unknownForeignKey.constraintName}.`,
    );
  }
}

function repairOperation(name, sql, params) {
  return params ? { name, sql, params } : { name, sql };
}

function normalizedForeignKeys(foreignKeys) {
  return (foreignKeys || [])
    .map((foreignKey) => ({
      constraintName: String(foreignKey.constraintName),
      sourceTable: String(foreignKey.sourceTable),
      sourceColumn: String(foreignKey.sourceColumn),
      targetTable: String(foreignKey.targetTable),
      targetColumn: String(foreignKey.targetColumn),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function validateRepairReport(report) {
  const repairStatus = report.repairState?.status || "not-repaired";
  if (repairStatus === "repaired") return;
  if (repairStatus === "partial") {
    throw new Error(`Reparo parcial ou inconsistente: ${report.repairState.reason || "estado desconhecido"}.`);
  }
  const unknownForeignKey = (report.foreignKeys || []).find(isUnknownExternalForeignKey);
  if (unknownForeignKey) {
    throw new Error(`Foreign key externo desconhecido: ${unknownForeignKey.constraintName}.`);
  }

  const unknownTable = (report.activeAvantrackingObjects || []).find(
    (tableName) => !AVANTRACKING_ONLY_TABLES.includes(tableName),
  );
  if (unknownTable) {
    throw new Error(`Tabela fora do inventario permitido: ${unknownTable}.`);
  }

  const appliedMigrations = report.shopeeAppliedMigrations instanceof Set
    ? report.shopeeAppliedMigrations
    : new Set(report.shopeeAppliedMigrations || []);
  const missing = missingMigrations(appliedMigrations);
  if (missing.length) {
    throw new Error(`Migration ausente no historico Shopee: ${missing.join(", ")}.`);
  }
}

function buildRepairPlan(report) {
  validateRepairReport(report);

  if (report.repairState?.status === "repaired") {
    const noOpPlan = [];
    noOpPlan.repairContext = Object.freeze({ noOp: true });
    return noOpPlan;
  }

  const activeTableSet = new Set(report.activeAvantrackingObjects || []);
  const activeAvantrackingObjects = AVANTRACKING_ONLY_TABLES.filter((tableName) => (
    activeTableSet.has(tableName)
  ));
  const observedForeignKeys = report.foreignKeys || [];
  const contaminatedForeignKeys = KNOWN_CONTAMINATED_FK_TUPLES.filter((tuple) => (
    observedForeignKeys.some((foreignKey) => foreignKeyMatchesTuple(foreignKey, tuple))
  ));
  const appliedMigrations = report.shopeeAppliedMigrations instanceof Set
    ? report.shopeeAppliedMigrations
    : new Set(report.shopeeAppliedMigrations || []);
  const unrelatedMigrationNames = [...appliedMigrations]
    .filter((name) => !MISPLACED_MIGRATIONS.includes(name))
    .map(String)
    .sort();
  const lockedSourceTables = [
    ...SHARED_TABLES,
    ...activeAvantrackingObjects,
    "_davantti_sql_migrations",
  ];
  const sourceCountSelects = lockedSourceTables.map((tableName, index) => {
    const source = tableName === "_davantti_sql_migrations"
      ? `"public"."_davantti_sql_migrations"`
      : `"public"."${tableName}"`;
    return `SELECT $${index + 1}::text AS "sourceTable", COUNT(*)::bigint AS "rowCount" FROM ${source}`;
  });
  const misplacedLabelIndex = lockedSourceTables.length + 1;
  const migrationNamesIndex = lockedSourceTables.length + 2;
  sourceCountSelects.push(`
    SELECT $${misplacedLabelIndex}::text AS "sourceTable", COUNT(*)::bigint AS "rowCount"
    FROM "public"."_davantti_sql_migrations"
    WHERE "name" = ANY($${migrationNamesIndex}::text[])
  `);
  const plan = [
    repairOperation(
      "acquire-advisory-lock",
      `SELECT pg_advisory_xact_lock(${REPAIR_ADVISORY_LOCK})`,
    ),
    {
      name: "reinspect-repair-state-after-advisory",
      action: "reinspectRepairState",
    },
    {
      name: "refresh-lock-revalidate-source-inventory",
      action: "refreshLockRevalidateSourceInventory",
    },
    {
      name: "validate-current-foreign-keys",
      sql: `
        /* pre-repair foreign keys */
        SELECT
          con.conname AS "constraintName",
          src.relname AS "sourceTable",
          src_att.attname AS "sourceColumn",
          tgt.relname AS "targetTable",
          tgt_att.attname AS "targetColumn"
        FROM pg_constraint con
        JOIN pg_class src ON src.oid = con.conrelid
        JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
        JOIN pg_class tgt ON tgt.oid = con.confrelid
        JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
        JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS src_key(attnum, position) ON true
        JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS tgt_key(attnum, position)
          ON tgt_key.position = src_key.position
        JOIN pg_attribute src_att ON src_att.attrelid = src.oid AND src_att.attnum = src_key.attnum
        JOIN pg_attribute tgt_att ON tgt_att.attrelid = tgt.oid AND tgt_att.attnum = tgt_key.attnum
        WHERE con.contype = 'f'
          AND src_ns.nspname = 'public'
          AND tgt_ns.nspname = 'public'
          AND (
            src.relname = ANY($1)
            OR tgt.relname = ANY($1)
            OR tgt.relname = 'User'
          )
        ORDER BY con.conname, src_key.position
      `,
      params: [[...new Set([...AVANTRACKING_ONLY_TABLES, ...SHARED_TABLES])]],
      expectedRows: normalizedForeignKeys(observedForeignKeys),
    },
    {
      name: "capture-locked-source-row-counts",
      sql: `
        /* locked source row counts */
        ${sourceCountSelects.join("\n        UNION ALL\n        ")}
      `,
      params: [
        ...lockedSourceTables,
        "_davantti_sql_migrations:misplaced",
        MISPLACED_MIGRATIONS,
      ],
      capturesSourceRowCounts: true,
    },
    {
      name: "capture-locked-migration-snapshot-evidence",
      sql: `
        /* locked migration snapshot evidence */
        SELECT history_row."name", to_jsonb(history_row)::text AS "rowData"
        FROM "public"."_davantti_sql_migrations" AS history_row
        WHERE history_row."name" = ANY($1::text[])
        ORDER BY history_row."name"
      `,
      params: [MISPLACED_MIGRATIONS],
      capturesMigrationSnapshots: true,
    },
    ...SHARED_TABLES.map((tableName) => ({
      name: `capture-locked-shared-evidence-${tableName}`,
      sql: `
        /* locked shared snapshot evidence */
        SELECT $1::text AS "sourceTable", source_row."id"::text AS "originalId",
          to_jsonb(source_row)::text AS "rowData"
        FROM "public"."${tableName}" AS source_row
        ORDER BY source_row."id"::text
      `,
      params: [tableName],
      capturesSharedSnapshotEvidence: tableName,
    })),
    repairOperation(
      "create-quarantine-schema",
      `CREATE SCHEMA IF NOT EXISTS "${QUARANTINE_SCHEMA}"`,
    ),
    repairOperation(
      "create-repair-manifest-table",
      `
        CREATE TABLE IF NOT EXISTS "${QUARANTINE_SCHEMA}"."repair_manifest" (
          "key" TEXT PRIMARY KEY,
          "snapshot" JSONB NOT NULL,
          "captured_at" TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp()
        )
      `,
    ),
    repairOperation(
      "create-migration-history-table",
      `
        CREATE TABLE IF NOT EXISTS "${QUARANTINE_SCHEMA}"."migration_history" (
          "name" TEXT PRIMARY KEY,
          "snapshot" JSONB NOT NULL
        )
      `,
    ),
    repairOperation(
      "create-shared-row-snapshots-table",
      `
        CREATE TABLE IF NOT EXISTS "${QUARANTINE_SCHEMA}"."shared_row_snapshots" (
          "source_table" TEXT NOT NULL,
          "original_id" TEXT NOT NULL,
          "snapshot" JSONB NOT NULL,
          PRIMARY KEY ("source_table", "original_id")
        )
      `,
    ),
    {
      name: "write-repair-manifest",
      sql: `
        INSERT INTO "${QUARANTINE_SCHEMA}"."repair_manifest" ("key", "snapshot")
        VALUES ($1, $2::jsonb)
      `,
      dynamicParams: "manifest",
    },
    repairOperation(
      "snapshot-migration-history",
      `
        INSERT INTO "${QUARANTINE_SCHEMA}"."migration_history" ("name", "snapshot")
        SELECT history_row."name", to_jsonb(history_row)
        FROM "public"."_davantti_sql_migrations" AS history_row
        WHERE history_row."name" = ANY($1::text[])
        ORDER BY history_row."name"
      `,
      [MISPLACED_MIGRATIONS],
    ),
  ];

  for (const tableName of SHARED_TABLES) {
    plan.push(repairOperation(
      `snapshot-shared-${tableName}`,
      `
        INSERT INTO "${QUARANTINE_SCHEMA}"."shared_row_snapshots"
          ("source_table", "original_id", "snapshot")
        SELECT $1, source_row."id"::text, to_jsonb(source_row)
        FROM "public"."${tableName}" AS source_row
        ORDER BY source_row."id"::text
      `,
      [tableName],
    ));
  }

  for (const [constraintName, sourceTable] of contaminatedForeignKeys) {
    plan.push(repairOperation(
      `drop-fk-${constraintName}`,
      `ALTER TABLE "public"."${sourceTable}" DROP CONSTRAINT "${constraintName}"`,
    ));
  }

  for (const tableName of activeAvantrackingObjects) {
    plan.push(repairOperation(
      `move-table-${tableName}`,
      `ALTER TABLE "public"."${tableName}" SET SCHEMA "${QUARANTINE_SCHEMA}"`,
    ));
  }

  for (const tableName of SHARED_TABLES) {
    const drops = SHARED_CONTAMINATED_COLUMNS[tableName]
      .map((columnName) => `DROP COLUMN IF EXISTS "${columnName}"`)
      .join(",\n          ");
    plan.push(repairOperation(
      `drop-columns-${tableName}`,
      `
        ALTER TABLE "public"."${tableName}"
          ${drops}
      `,
    ));
  }

  plan.push(repairOperation(
    "delete-misplaced-migration-history",
    `
      DELETE FROM "public"."_davantti_sql_migrations"
      WHERE "name" = ANY($1::text[])
    `,
    [MISPLACED_MIGRATIONS],
  ));

  plan.repairContext = Object.freeze({
    activeAvantrackingObjects: Object.freeze([...activeAvantrackingObjects]),
    canonicalColumns: CANONICAL_SHARED_COLUMNS,
    contaminatedForeignKeys: Object.freeze(normalizedForeignKeys(
      contaminatedForeignKeys.map(([
        constraintName, sourceTable, sourceColumn, targetTable, targetColumn,
      ]) => ({ constraintName, sourceTable, sourceColumn, targetTable, targetColumn })),
    )),
    observedForeignKeys: Object.freeze(normalizedForeignKeys(observedForeignKeys)),
    lockedSourceTables: Object.freeze(lockedSourceTables),
    sourceMigrationNames: Object.freeze([...appliedMigrations].map(String).sort()),
    unrelatedMigrationNames: Object.freeze(unrelatedMigrationNames),
    avantrackingMigrationSnapshots: Object.freeze(structuredClone(
      report.avantrackingMigrationSnapshots || [],
    )),
  });
  return plan;
}

function normalizedOperationSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function serializedRepairOperations(plan) {
  return plan.map((operation) => ({
    name: operation.name,
    ...(operation.action
      ? { action: operation.action }
      : {
        sql: normalizedOperationSql(operation.sql),
        params: operation.dynamicParams
          ? { dynamic: operation.dynamicParams }
          : structuredClone(operation.params || []),
      }),
  }));
}

function operationKindsForPlan(plan) {
  const kinds = [];
  let includedForeignKeyGroup = false;
  let includedTableMoveGroup = false;
  for (const operation of plan) {
    let kind;
    if (operation.name.startsWith("drop-fk-")) {
      kind = "repeat:drop-observed-known-contaminated-fk";
      includedForeignKeyGroup = true;
    } else if (operation.name.startsWith("move-table-")) {
      if (!includedForeignKeyGroup) kinds.push("repeat:drop-observed-known-contaminated-fk");
      includedForeignKeyGroup = true;
      includedTableMoveGroup = true;
      kind = "repeat:move-observed-avantracking-table";
    } else {
      if (operation.name.startsWith("drop-columns-")) {
        if (!includedForeignKeyGroup) kinds.push("repeat:drop-observed-known-contaminated-fk");
        if (!includedTableMoveGroup) kinds.push("repeat:move-observed-avantracking-table");
        includedForeignKeyGroup = true;
        includedTableMoveGroup = true;
      }
      kind = `${operation.action ? "action" : "sql"}:${operation.name}`;
    }
    if (kinds.at(-1) !== kind || !kind.startsWith("repeat:")) kinds.push(kind);
  }
  return kinds;
}

function normalizedMigrationSnapshots(rows) {
  return (rows || []).map((row) => ({
    name: String(row.name),
    rowData: String(row.rowData),
  })).sort((left, right) => left.name.localeCompare(right.name));
}

function validateMigrationSnapshots(rows) {
  const snapshots = normalizedMigrationSnapshots(rows);
  if (!exactStringSet(snapshots.map(({ name }) => name), MISPLACED_MIGRATIONS)
    || snapshots.length !== MISPLACED_MIGRATIONS.length) {
    throw new Error("Evidencia das migrations contaminadas esta incompleta.");
  }
  for (const { name, rowData } of snapshots) {
    let snapshot;
    try {
      snapshot = JSON.parse(rowData);
    } catch {
      throw new Error(`JSONB do snapshot de migration invalido: ${name}.`);
    }
    if (!snapshot || snapshot.name !== name
      || !Object.hasOwn(snapshot, "checksum")
      || !Object.hasOwn(snapshot, "source")
      || !Object.hasOwn(snapshot, "applied_at")) {
      throw new Error(`Metadados do snapshot de migration invalidos: ${name}.`);
    }
  }
  return snapshots;
}

function validateExternalMigrationReference(sourceSnapshots, referenceSnapshots) {
  validateMigrationSnapshots(sourceSnapshots);
  validateMigrationSnapshots(referenceSnapshots);
}

function sharedEvidenceFromRows(rows) {
  const grouped = new Map(SHARED_TABLES.map((tableName) => [tableName, []]));
  for (const row of rows || []) {
    const tableName = String(row.sourceTable);
    if (!grouped.has(tableName)) throw new Error(`Tabela compartilhada inesperada: ${tableName}.`);
    grouped.get(tableName).push({
      originalId: String(row.originalId),
      rowData: String(row.rowData),
    });
  }
  // These checksums detect corruption/consistency failures; they are not administrator-proof signatures.
  return SHARED_TABLES.map((sourceTable) => {
    const snapshots = grouped.get(sourceTable)
      .sort((left, right) => left.originalId.localeCompare(right.originalId));
    return {
      sourceTable,
      rowCount: snapshots.length,
      contentSha256: sha256(stableJson(snapshots)),
    };
  });
}

function orderedSourceRowCounts(repairContext, rows) {
  const countMap = new Map(rows.map((row) => [String(row.sourceTable), Number(row.rowCount)]));
  const names = [...repairContext.lockedSourceTables, "_davantti_sql_migrations:misplaced"];
  const result = {};
  for (const name of names) {
    if (!countMap.has(name) || !Number.isSafeInteger(countMap.get(name)) || countMap.get(name) < 0) {
      throw new Error(`Contagem de origem ausente ou invalida: ${name}.`);
    }
    result[name] = countMap.get(name);
  }
  if (countMap.size !== names.length) throw new Error("Inventario de contagens de origem divergente.");
  if (result["_davantti_sql_migrations:misplaced"] !== MISPLACED_MIGRATIONS.length) {
    throw new Error("Contagem das migrations contaminadas diverge do manifesto esperado.");
  }
  return result;
}

function buildExecutionManifest(plan, executionState) {
  if (stableJson(operationKindsForPlan(plan)) !== stableJson(REPAIR_OPERATION_KINDS)) {
    throw new Error("Ordem estatica das operacoes de reparo invalida.");
  }
  const manifest = {
    format: REPAIR_MANIFEST_FORMAT,
    version: REPAIR_MANIFEST_VERSION,
    advisoryLock: REPAIR_ADVISORY_LOCK,
    quarantineSchema: QUARANTINE_SCHEMA,
    sourceRowCounts: executionState.sourceRowCounts,
    operations: serializedRepairOperations(plan),
    staticEvidence: staticRepairEvidence(),
    recovery: {
      activeAvantrackingObjects: [...plan.repairContext.activeAvantrackingObjects],
      contaminatedForeignKeys: structuredClone(plan.repairContext.contaminatedForeignKeys),
      observedForeignKeys: structuredClone(plan.repairContext.observedForeignKeys),
      unrelatedMigrationNames: [...plan.repairContext.unrelatedMigrationNames],
      sourceMigrationNames: [...plan.repairContext.sourceMigrationNames],
      lockedSourceTables: [...plan.repairContext.lockedSourceTables],
      migrationSnapshots: structuredClone(executionState.migrationSnapshots),
      sharedSnapshotEvidence: structuredClone(executionState.sharedSnapshotEvidence),
    },
  };
  manifest.evidenceSha256 = sha256(stableJson(manifest));
  return manifest;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateRepairOperation(operation, result, executionState) {
  if (operation.expectedRows) {
    const actualRows = normalizedForeignKeys(result.rows);
    if (JSON.stringify(actualRows) !== JSON.stringify(operation.expectedRows)) {
      throw new Error("Foreign keys do banco mudaram depois do preflight.");
    }
  }
  if (operation.capturesSourceRowCounts) {
    executionState.sourceRowCounts = orderedSourceRowCounts(executionState.repairContext, result.rows);
  }
  if (operation.capturesMigrationSnapshots) {
    executionState.migrationSnapshots = validateMigrationSnapshots(result.rows);
    validateExternalMigrationReference(
      executionState.migrationSnapshots,
      executionState.repairContext.avantrackingMigrationSnapshots,
    );
  }
  if (operation.capturesSharedSnapshotEvidence) {
    const evidence = sharedEvidenceFromRows(result.rows)[SHARED_TABLES.indexOf(
      operation.capturesSharedSnapshotEvidence,
    )];
    if (evidence.rowCount !== executionState.sourceRowCounts[operation.capturesSharedSnapshotEvidence]) {
      throw new Error(`Contagem da evidencia compartilhada diverge: ${operation.capturesSharedSnapshotEvidence}.`);
    }
    executionState.sharedSnapshotEvidence.push(evidence);
  }
}

function rowPairSet(rows, firstKey, secondKey) {
  return new Set(rows.map((row) => `${row[firstKey]}.${row[secondKey]}`));
}

async function verifyPostRepair(client, repairContext, expectedManifest) {
  const tableResult = await client.query(`
    /* post-repair table locations */
    SELECT table_name AS "tableName", table_schema AS "tableSchema"
    FROM information_schema.tables
    WHERE table_schema = ANY($1::text[])
      AND table_name = ANY($2::text[])
    ORDER BY table_schema, table_name
  `, [["public", QUARANTINE_SCHEMA], AVANTRACKING_ONLY_TABLES]);
  const publicTables = new Set(
    tableResult.rows
      .filter((row) => row.tableSchema === "public")
      .map((row) => String(row.tableName)),
  );
  if (publicTables.size) {
    throw new Error(`Tabelas Avantracking ainda presentes em public: ${[...publicTables].join(", ")}.`);
  }
  const quarantinedTables = new Set(
    tableResult.rows
      .filter((row) => row.tableSchema === QUARANTINE_SCHEMA)
      .map((row) => String(row.tableName)),
  );
  const missingQuarantinedTable = repairContext.activeAvantrackingObjects.find(
    (tableName) => !quarantinedTables.has(tableName),
  );
  if (missingQuarantinedTable) {
    throw new Error(`Tabela Avantracking ausente da quarentena: ${missingQuarantinedTable}.`);
  }

  const foreignKeyResult = await client.query(`
    /* post-repair foreign keys */
    SELECT con.conname AS "constraintName"
    FROM pg_constraint con
    WHERE con.contype = 'f'
      AND con.conname = ANY($1::text[])
    ORDER BY con.conname
  `, [[...KNOWN_CONTAMINATED_FKS]]);
  if (foreignKeyResult.rows.length) {
    throw new Error(`Foreign key contaminada ainda presente: ${foreignKeyResult.rows[0].constraintName}.`);
  }

  const columnResult = await client.query(`
    /* post-repair shared columns */
    SELECT table_name AS "tableName", column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
    ORDER BY table_name, ordinal_position
  `, [SHARED_TABLES]);
  const remainingColumns = rowPairSet(columnResult.rows, "tableName", "columnName");
  for (const tableName of SHARED_TABLES) {
    const remainingContaminatedColumn = SHARED_CONTAMINATED_COLUMNS[tableName].find(
      (columnName) => remainingColumns.has(`${tableName}.${columnName}`),
    );
    if (remainingContaminatedColumn) {
      throw new Error(`Coluna contaminada ainda presente: ${tableName}.${remainingContaminatedColumn}.`);
    }
  }
  const missingCanonicalColumn = repairContext.canonicalColumns.find(
    ([tableName, columnName]) => !remainingColumns.has(`${tableName}.${columnName}`),
  );
  if (missingCanonicalColumn) {
    throw new Error(`Coluna canonica ausente: ${missingCanonicalColumn.join(".")}.`);
  }

  const migrationResult = await client.query(`
    /* post-repair migration history */
    SELECT "name", COUNT(*) OVER ()::bigint AS "totalCount"
    FROM "public"."_davantti_sql_migrations"
    WHERE "name" = ANY($1::text[])
       OR "name" = ANY($2::text[])
    ORDER BY "name"
  `, [MISPLACED_MIGRATIONS, repairContext.unrelatedMigrationNames]);
  const activeMigrations = new Set(migrationResult.rows.map((row) => String(row.name)));
  const remainingMisplacedMigration = MISPLACED_MIGRATIONS.find((name) => activeMigrations.has(name));
  if (remainingMisplacedMigration) {
    throw new Error(`Migration contaminada ainda ativa: ${remainingMisplacedMigration}.`);
  }
  const missingUnrelatedMigration = repairContext.unrelatedMigrationNames.find(
    (name) => !activeMigrations.has(name),
  );
  if (missingUnrelatedMigration) {
    throw new Error(`Migration nao relacionada foi removida: ${missingUnrelatedMigration}.`);
  }
  const expectedActiveHistoryCount = expectedManifest.sourceRowCounts._davantti_sql_migrations
    - MISPLACED_MIGRATIONS.length;
  const activeHistoryCount = Number(migrationResult.rows[0]?.totalCount || migrationResult.rows.length);
  if (activeHistoryCount !== expectedActiveHistoryCount) {
    throw new Error("Contagem do historico ativo diverge do manifesto.");
  }

  const quarantinedMigrationResult = await client.query(`
    /* post-repair quarantine migrations */
    SELECT "name", "snapshot"::text AS "rowData"
    FROM "${QUARANTINE_SCHEMA}"."migration_history"
    WHERE "name" = ANY($1::text[])
    ORDER BY "name"
  `, [MISPLACED_MIGRATIONS]);
  const quarantinedMigrations = new Set(quarantinedMigrationResult.rows.map((row) => String(row.name)));
  const missingMigrationSnapshot = MISPLACED_MIGRATIONS.find(
    (name) => !quarantinedMigrations.has(name),
  );
  if (missingMigrationSnapshot || quarantinedMigrations.size !== MISPLACED_MIGRATIONS.length) {
    throw new Error(`Snapshot de migration incompleto: ${missingMigrationSnapshot || "contagem divergente"}.`);
  }
  if (stableJson(normalizedMigrationSnapshots(quarantinedMigrationResult.rows))
    !== stableJson(normalizedMigrationSnapshots(expectedManifest.recovery.migrationSnapshots))) {
    throw new Error("Conteudo do snapshot de migration diverge do manifesto.");
  }

  const sharedSnapshotResult = await client.query(`
    /* post-repair shared snapshots */
    SELECT "source_table" AS "sourceTable", "original_id" AS "originalId",
      "snapshot"::text AS "rowData"
    FROM "${QUARANTINE_SCHEMA}"."shared_row_snapshots"
    ORDER BY "source_table", "original_id"
  `);
  const observedSharedEvidence = sharedEvidenceFromRows(sharedSnapshotResult.rows);
  if (stableJson(observedSharedEvidence)
    !== stableJson(expectedManifest.recovery.sharedSnapshotEvidence)) {
    throw new Error("Integridade dos snapshots compartilhados diverge do manifesto.");
  }

  if (repairContext.activeAvantrackingObjects.length) {
    const selects = repairContext.activeAvantrackingObjects.map((tableName, index) => `
      SELECT $${index + 1}::text AS "sourceTable", COUNT(*)::bigint AS "rowCount"
      FROM "${QUARANTINE_SCHEMA}"."${tableName}"
    `);
    const quarantineCountResult = await client.query(`
      /* post-repair quarantine table row counts */
      ${selects.join(" UNION ALL ")}
    `, repairContext.activeAvantrackingObjects);
    for (const row of quarantineCountResult.rows) {
      if (Number(row.rowCount) !== expectedManifest.sourceRowCounts[row.sourceTable]) {
        throw new Error(`Contagem da tabela em quarentena diverge: ${row.sourceTable}.`);
      }
    }
  }

  const manifestResult = await client.query(`
    /* post-repair manifest */
    SELECT "snapshot"
    FROM "${QUARANTINE_SCHEMA}"."repair_manifest"
    WHERE "key" = $1
  `, ["repair-plan"]);
  if (manifestResult.rows.length !== 1
    || stableJson(manifestResult.rows[0].snapshot) !== stableJson(expectedManifest)) {
    throw new Error("Manifesto de reparo ausente ou divergente.");
  }
}

async function executeRepair(client, plan) {
  if (!Array.isArray(plan) || !plan.repairContext) {
    throw new Error("Plano de reparo invalido.");
  }
  if (plan.repairContext.noOp) {
    return {
      committed: true,
      noOp: true,
      operationCount: 0,
      movedTableCount: 0,
      quarantinedMigrationCount: MISPLACED_MIGRATIONS.length,
    };
  }

  await client.query("BEGIN");
  try {
    validateRepairPlanBlueprint(plan);
    const advisoryOperation = plan[0];
    if (advisoryOperation?.name !== "acquire-advisory-lock"
      || normalizedOperationSql(advisoryOperation.sql)
        !== `SELECT pg_advisory_xact_lock(${REPAIR_ADVISORY_LOCK})`) {
      throw new Error("Operacao de advisory lock ausente do plano de reparo.");
    }
    await client.query(advisoryOperation.sql, advisoryOperation.params || []);
    const current = await inspectCurrentRepairState(
      client,
      plan.repairContext.avantrackingMigrationSnapshots,
    );
    if (current.repairState.status === "repaired") {
      await client.query("COMMIT");
      return {
        committed: true,
        noOp: true,
        operationCount: 0,
        movedTableCount: 0,
        quarantinedMigrationCount: MISPLACED_MIGRATIONS.length,
      };
    }
    if (current.repairState.status !== "not-repaired") {
      throw new Error(
        `Reparo parcial ou inconsistente: ${current.repairState.reason || "estado desconhecido"}.`,
      );
    }

    const refreshedPlan = await buildLockedRepairPlan(client, plan.repairContext);
    const executionPlan = dynamicRepairContextMatches(plan.repairContext, refreshedPlan.repairContext)
      ? plan
      : refreshedPlan;
    const executionState = {
      repairContext: executionPlan.repairContext,
      sourceRowCounts: null,
      migrationSnapshots: null,
      sharedSnapshotEvidence: [],
    };
    let manifest;
    for (const operation of executionPlan.slice(3)) {
      let params = operation.params || [];
      if (operation.dynamicParams === "manifest") {
        if (!executionState.sourceRowCounts
          || !executionState.migrationSnapshots
          || executionState.sharedSnapshotEvidence.length !== SHARED_TABLES.length) {
          throw new Error("Evidencias de origem nao foram capturadas.");
        }
        manifest = buildExecutionManifest(executionPlan, executionState);
        params = ["repair-plan", JSON.stringify(manifest)];
      }
      const result = await client.query(operation.sql, params);
      validateRepairOperation(operation, result, executionState);
    }
    if (!manifest) throw new Error("Manifesto de reparo nao foi persistido.");
    await verifyPostRepair(client, executionPlan.repairContext, manifest);
    await client.query("COMMIT");
    return {
      committed: true,
      noOp: false,
      operationCount: executionPlan.length,
      movedTableCount: executionPlan.repairContext.activeAvantrackingObjects.length,
      quarantinedMigrationCount: MISPLACED_MIGRATIONS.length,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

module.exports = {
  AVANTRACKING_ONLY_TABLES,
  CANONICAL_SHARED_COLUMNS,
  CANONICAL_SHOPEE_USER_FK_TUPLES,
  KNOWN_CONTAMINATED_FKS,
  KNOWN_CONTAMINATED_FK_TUPLES,
  MISPLACED_MIGRATIONS,
  QUARANTINE_SCHEMA,
  REPAIR_ADVISORY_LOCK,
  SHARED_CONTAMINATED_COLUMNS,
  buildRepairPlan,
  executeRepair,
  inspectContamination,
  inspectCurrentRepairState,
  inspectRepairState,
  validatePreflight,
  verifyPostRepair,
};
