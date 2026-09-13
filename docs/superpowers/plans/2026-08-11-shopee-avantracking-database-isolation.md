# Shopee and Avantracking Database Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Avantracking from ever falling back to the Shopee database, quarantine the known Avantracking contamination in Shopee, and apply every pending Shopee migration safely.

**Architecture:** A shared CommonJS database-target module will enforce explicit Avantracking configuration and compare canonical Neon targets. A dedicated Shopee repair command will inspect both databases, default to dry-run, quarantine misplaced objects in one transaction, remove only the incompatible cross-module constraints/history, and then hand control back to the standard Shopee migration runner.

**Tech Stack:** Node.js 22, CommonJS, TypeScript, PostgreSQL via `pg`, Node built-in test runner, Render Blueprint.

## Global Constraints

- Never log credentials or complete database URLs.
- Avantracking must require `AVANTRACKING_DATABASE_URL`; process-wide `DATABASE_URL` is not a fallback.
- Neon direct and `-pooler` hostnames for the same endpoint, database, and schema represent the same canonical target.
- Database repair defaults to dry-run and requires explicit target confirmation for writes.
- All repair writes use one PostgreSQL transaction and an advisory lock.
- Contaminated tables and values are quarantined; this work does not delete the quarantine schema.
- The real Avantracking database must contain all eleven misplaced migration names before Shopee repair can run.
- Existing unrelated worktree changes must not be staged or modified.

---

### Task 1: Canonical Database Target Guard

**Files:**
- Create: `avantracking/databaseTarget.cjs`
- Create: `avantracking/databaseTarget.test.cjs`

**Interfaces:**
- Produces: `canonicalizeDatabaseTarget(rawUrl): { host: string, database: string, schema: string, fingerprint: string }`
- Produces: `resolveAvantrackingDatabaseUrl(env): string`
- Produces: `assertDistinctDatabaseTargets(shopeeUrl, avantrackingUrl): void`

- [ ] **Step 1: Write failing target-identity tests**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canonicalizeDatabaseTarget,
  resolveAvantrackingDatabaseUrl,
} = require("./databaseTarget.cjs");

test("requires AVANTRACKING_DATABASE_URL without DATABASE_URL fallback", () => {
  assert.throws(
    () => resolveAvantrackingDatabaseUrl({ DATABASE_URL: "postgresql://u:p@shopee/neondb" }),
    /AVANTRACKING_DATABASE_URL/,
  );
});

test("treats Neon direct and pooler hosts as the same target", () => {
  const direct = canonicalizeDatabaseTarget("postgresql://u:p@ep-sample.us-west-2.aws.neon.tech/neondb?sslmode=require");
  const pooler = canonicalizeDatabaseTarget("postgresql://u:p@ep-sample-pooler.us-west-2.aws.neon.tech/neondb?sslmode=require");
  assert.equal(direct.fingerprint, pooler.fingerprint);
});

test("rejects an Avantracking target equal to DATABASE_URL", () => {
  assert.throws(
    () => resolveAvantrackingDatabaseUrl({
      DATABASE_URL: "postgresql://u:p@ep-sample-pooler.us-west-2.aws.neon.tech/neondb",
      AVANTRACKING_DATABASE_URL: "postgresql://u:p@ep-sample.us-west-2.aws.neon.tech/neondb",
    }),
    /mesmo banco/i,
  );
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test avantracking/databaseTarget.test.cjs`

Expected: FAIL because `avantracking/databaseTarget.cjs` does not exist.

- [ ] **Step 3: Implement canonicalization and fail-closed resolution**

```js
"use strict";

const crypto = require("node:crypto");

function canonicalizeDatabaseTarget(rawUrl) {
  const parsed = new URL(String(rawUrl || "").trim());
  const host = parsed.hostname.toLowerCase().replace(/-pooler(?=\.)/, "");
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const schema = parsed.searchParams.get("schema") || "public";
  const identity = `${host}|${database}|${schema}`;
  return {
    host,
    database,
    schema,
    fingerprint: crypto.createHash("sha256").update(identity).digest("hex").slice(0, 12),
  };
}

function assertDistinctDatabaseTargets(shopeeUrl, avantrackingUrl) {
  if (!shopeeUrl) return;
  if (canonicalizeDatabaseTarget(shopeeUrl).fingerprint === canonicalizeDatabaseTarget(avantrackingUrl).fingerprint) {
    throw new Error("AVANTRACKING_DATABASE_URL aponta para o mesmo banco de DATABASE_URL.");
  }
}

function resolveAvantrackingDatabaseUrl(env = process.env) {
  const specific = String(env.AVANTRACKING_DATABASE_URL || "").trim();
  if (!specific) throw new Error("AVANTRACKING_DATABASE_URL nao configurada.");
  assertDistinctDatabaseTargets(env.DATABASE_URL, specific);
  return specific;
}

module.exports = { canonicalizeDatabaseTarget, assertDistinctDatabaseTargets, resolveAvantrackingDatabaseUrl };
```

- [ ] **Step 4: Run target tests and verify GREEN**

Run: `node --test avantracking/databaseTarget.test.cjs`

Expected: 3 passing tests and exit code 0.

- [ ] **Step 5: Commit the guard**

```bash
git add avantracking/databaseTarget.cjs avantracking/databaseTarget.test.cjs
git commit -m "fix(avantracking): require isolated database target"
```

### Task 2: Wire Fail-Closed Behavior Into Runtime, Migrations, and Render

**Files:**
- Modify: `avantracking/index.cjs`
- Modify: `avantracking/server/src/lib/db.ts`
- Modify: `avantracking/server/scripts/db-migrate.js`
- Modify: `render.yaml`
- Create: `avantracking/server/.env.example.txt`
- Create: `avantracking/databaseWiring.test.cjs`

**Interfaces:**
- Consumes: `resolveAvantrackingDatabaseUrl(env)` from Task 1.
- Produces: Runtime and migration processes that use only `AVANTRACKING_DATABASE_URL`.

- [ ] **Step 1: Write failing wiring tests**

The test will read the three wiring files and assert that runtime resolution uses the shared guard, the migration runner lists only `AVANTRACKING_DATABASE_URL`, and `render.yaml` declares the secret.

```js
test("migration runner has no generic database fallback", () => {
  const source = fs.readFileSync(path.join(__dirname, "server", "scripts", "db-migrate.js"), "utf8");
  assert.match(source, /resolveAvantrackingDatabaseUrl/);
  assert.match(source, /databaseEnvKeys:\s*\["AVANTRACKING_DATABASE_URL"\]/);
  assert.doesNotMatch(source, /databaseEnvKeys:\s*\[[^\]]*"DATABASE_URL"/);
});
```

- [ ] **Step 2: Run wiring tests and verify RED**

Run: `node --test avantracking/databaseWiring.test.cjs`

Expected: FAIL because the migration runner still accepts `DATABASE_URL` and Render lacks the specific secret declaration.

- [ ] **Step 3: Wire the shared guard**

In `avantracking/index.cjs`, retain mapping from an Avantracking-owned local `.env` file to `AVANTRACKING_DATABASE_URL`, then call `resolveAvantrackingDatabaseUrl(process.env)` before migration bootstrap.

In `avantracking/server/src/lib/db.ts`, replace the fallback expression with:

```ts
const { resolveAvantrackingDatabaseUrl } = require('../../../databaseTarget.cjs');

const createPool = () =>
  new Pool({ connectionString: resolveAvantrackingDatabaseUrl(process.env) });
```

In `avantracking/server/scripts/db-migrate.js`, validate the target before calling the runner and set:

```js
databaseEnvKeys: ["AVANTRACKING_DATABASE_URL"],
```

- [ ] **Step 4: Declare configuration explicitly**

Add this secret beside `DATABASE_URL` in the integrated Render service:

```yaml
      - key: AVANTRACKING_DATABASE_URL
        sync: false
```

Create `avantracking/server/.env.example.txt` containing only non-secret example values and `AVANTRACKING_DATABASE_URL` as the database key.

- [ ] **Step 5: Run focused and TypeScript verification**

Run: `node --test avantracking/databaseTarget.test.cjs avantracking/databaseWiring.test.cjs`

Run: `npm --prefix avantracking/server run build --if-present`

Expected: tests pass and TypeScript build exits 0.

- [ ] **Step 6: Commit runtime isolation**

```bash
git add avantracking/index.cjs avantracking/server/src/lib/db.ts avantracking/server/scripts/db-migrate.js avantracking/server/.env.example.txt avantracking/databaseWiring.test.cjs render.yaml
git commit -m "fix(avantracking): remove shared database fallback"
```

### Task 3: Shopee Contamination Inventory and Preflight

**Files:**
- Create: `shopee/scripts/lib/avantrackingContamination.js`
- Create: `shopee/scripts/repair-avantracking-contamination.js`
- Create: `shopee/test/avantrackingContamination.test.js`
- Modify: `shopee/package.json`

**Interfaces:**
- Produces: `MISPLACED_MIGRATIONS: readonly string[]` with the eleven confirmed names.
- Produces: `AVANTRACKING_ONLY_TABLES: readonly string[]` containing `Carrier`, `Company`, `CompanyOrderCustomStatus`, `LogisyncUser`, `MonitoredOrder`, `SyncNotification`, `TrackingEvent`, `TrayAuth`, `TrayCheckoutQuote`, and `UserAccessToken`.
- Produces: `SHARED_CONTAMINATED_COLUMNS` with the exact columns below.
- Produces: `inspectContamination(shopeeClient, avantrackingClient): Promise<ContaminationReport>`.
- Produces: `validatePreflight(report, expectedFingerprint): void`.
- Produces CLI: `npm --workspace shopee run db:repair:avantracking -- --expected-target=$shopeeTargetFingerprint` for dry-run.

The shared-column ownership manifest is:

```js
const SHARED_CONTAMINATED_COLUMNS = Object.freeze({
  User: ["password", "companyId", "phone", "birthDate", "profileImageData", "lastBirthdayCelebrationAt"],
  Order: [
    "orderNumber", "invoiceNumber", "trackingCode", "customerName", "corporateName", "cpf", "cnpj",
    "phone", "mobile", "salesChannel", "freightType", "freightValue", "quotedFreightValue",
    "quotedFreightDate", "quotedFreightDetails", "originalQuotedFreightValue", "originalQuotedFreightDate",
    "originalQuotedFreightDetails", "originalQuotedFreightQuotationId", "recalculatedFreightValue",
    "recalculatedFreightDate", "recalculatedFreightDetails", "shippingDate", "address", "number",
    "complement", "neighborhood", "city", "state", "zipCode", "totalValue", "recipient",
    "maxShippingDeadline", "estimatedDeliveryDate", "carrierEstimatedDeliveryDate", "status", "isDelayed",
    "isArchived", "archivedAt", "manualCustomStatus", "observation", "lastApiSync", "lastUpdate",
    "lastApiError", "apiRawPayload", "carrierId", "createdById", "companyId",
  ],
  ReleaseNote: ["sentByUserId"],
});
```

`User.userGlobalId` is canonical Shopee state and must not be classified as contamination.

- [ ] **Step 1: Write failing manifest and validation tests**

Tests must prove that the eleven migration names are exact, unknown external FKs stop execution, a missing migration in the real Avantracking history stops execution, and a mismatched target fingerprint stops execution.

```js
test("preflight rejects a missing Avantracking reference migration", () => {
  const report = validReport();
  report.avantrackingAppliedMigrations.delete(MISPLACED_MIGRATIONS[0]);
  assert.throws(() => validatePreflight(report, report.shopeeTarget.fingerprint), /migration ausente/i);
});
```

- [ ] **Step 2: Run preflight tests and verify RED**

Run: `node --test shopee/test/avantrackingContamination.test.js`

Expected: FAIL because the inventory module does not exist.

- [ ] **Step 3: Implement read-only inspection**

Inspection queries will return masked target identities, migration-name sets, table row counts, all FKs referencing `User`, critical column types, nonnumeric ID counts, and active objects from the explicit Avantracking-only table list. No query in `inspectContamination` may contain `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `DROP`, `CREATE`, or `TRUNCATE`.

Allowed known cross-module FKs are:

```js
const KNOWN_CONTAMINATED_FKS = new Set([
  "LogisyncUser_companyId_fkey",
  "MonitoredOrder_companyId_fkey",
  "MonitoredOrder_createdById_fkey",
  "Order_carrierId_fkey",
  "Order_companyId_fkey",
  "Order_createdById_fkey",
  "SyncNotification_companyId_fkey",
  "TrayAuth_companyId_fkey",
  "TrayCheckoutQuote_companyIdValue_fkey",
  "TrayCheckoutQuote_companyId_fkey",
  "User_companyId_fkey",
  "UserAccessToken_userId_fkey",
]);
```

Any other noncanonical FK to `User` must fail preflight.

- [ ] **Step 4: Implement dry-run CLI and package command**

The CLI will load `DATABASE_URL` from `shopee/src/.env`, require `AVANTRACKING_DATABASE_URL` from the process or Avantracking module env, call `assertDistinctDatabaseTargets`, print JSON with fingerprints/counts only, and exit without writes unless `--apply` is present.

Add:

```json
"db:repair:avantracking": "node scripts/repair-avantracking-contamination.js"
```

- [ ] **Step 5: Verify tests and real read-only preflight**

Run: `node --test shopee/test/avantrackingContamination.test.js`

Run: `npm --workspace shopee run db:repair:avantracking -- --expected-target=271508fcaaff`

Expected: tests pass; dry-run reports eleven misplaced migrations, distinct target fingerprints, and no write transaction.

- [ ] **Step 6: Commit preflight tooling**

```bash
git add shopee/scripts/lib/avantrackingContamination.js shopee/scripts/repair-avantracking-contamination.js shopee/test/avantrackingContamination.test.js shopee/package.json
git commit -m "feat(shopee): add contamination repair preflight"
```

### Task 4: Transactional Quarantine and Compatibility Repair

**Files:**
- Modify: `shopee/scripts/lib/avantrackingContamination.js`
- Modify: `shopee/scripts/repair-avantracking-contamination.js`
- Modify: `shopee/test/avantrackingContamination.test.js`

**Interfaces:**
- Produces: `buildRepairPlan(report): RepairOperation[]`.
- Produces: `executeRepair(client, plan): Promise<RepairResult>`.
- Repair schema: `quarantine_avantracking_20260811`.

- [ ] **Step 1: Write failing repair-plan tests**

Tests must assert this ordered behavior:

1. Acquire advisory lock `pg_advisory_xact_lock(736846420260811)`.
2. Create quarantine schema and manifest/history tables.
3. Copy the eleven migration-history rows into quarantine.
4. Copy shared-column values for `User`, `Order`, and `ReleaseNote` into JSONB quarantine snapshots keyed by original ID.
5. Drop every existing constraint from `KNOWN_CONTAMINATED_FKS` and fail if an unknown FK crosses the ownership boundary.
6. Move each existing Avantracking-only table from `public` to quarantine.
7. Drop only columns present in `SHARED_CONTAMINATED_COLUMNS`; PostgreSQL removes their dependent Avantracking indexes.
8. Delete only the eleven confirmed migration-history rows from the Shopee history table.
9. Commit only after post-repair validation succeeds.

```js
test("repair plan never drops a contaminated table", () => {
  const sql = buildRepairPlan(validReport()).map(operation => operation.sql).join("\n");
  assert.doesNotMatch(sql, /DROP\s+TABLE/i);
  assert.match(sql, /SET\s+SCHEMA\s+"quarantine_avantracking_20260811"/i);
});
```

- [ ] **Step 2: Run repair tests and verify RED**

Run: `node --test shopee/test/avantrackingContamination.test.js`

Expected: FAIL because `buildRepairPlan` and `executeRepair` are not implemented.

- [ ] **Step 3: Implement deterministic repair planning**

Use quoted identifiers from fixed constants only. Shared snapshots must use `to_jsonb(row)` so no contaminated column is lost. History copies must include `name`, `checksum`, `source`, `applied_at`, and `execution_ms` when present.

The plan removes only the explicit shared-column manifest after copying complete source rows to quarantine. It must not remove canonical fields such as `User.userGlobalId`, `User.accountId`, `Order.orderSn`, `Order.orderStatus`, or any Shopee financial column. The official Shopee compatibility migration will convert `User.id`, restore numeric references/defaults, and recreate canonical Shopee FKs.

- [ ] **Step 4: Implement transactional execution and post-checks**

Execution uses one checked-out client:

```js
await client.query("BEGIN");
try {
  for (const operation of plan) await client.query(operation.sql, operation.params || []);
  await verifyPostRepair(client);
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
}
```

`verifyPostRepair` must confirm all Avantracking-only tables are absent from `public`, all are present in quarantine when they existed before, all known contaminated FKs and columns are absent, canonical columns remain, and all unrelated migration-history rows remain.

- [ ] **Step 5: Prove dry-run and transaction behavior**

Run: `node --test shopee/test/avantrackingContamination.test.js`

Run the CLI without `--apply` and compare the database migration count before and after; both counts must match.

- [ ] **Step 6: Commit repair execution**

```bash
git add shopee/scripts/lib/avantrackingContamination.js shopee/scripts/repair-avantracking-contamination.js shopee/test/avantrackingContamination.test.js
git commit -m "feat(shopee): quarantine Avantracking schema contamination"
```

### Task 5: Stage Repair, Apply Shopee Migrations, and Verify

**Files:**
- Modify only if verification exposes a repository defect: `shopee/db/migrations/20260424230000_ensure_numeric_identity_compatibility/migration.sql`
- Record evidence in command output; do not commit credentials or database reports containing sensitive rows.

**Interfaces:**
- Consumes: isolation guard, preflight CLI, repair CLI, standard Shopee migration runner.
- Produces: repaired staging database with zero pending Shopee migrations.

- [ ] **Step 1: Verify code before database writes**

Run: `node --test avantracking/databaseTarget.test.cjs avantracking/databaseWiring.test.cjs shopee/test/avantrackingContamination.test.js`

Run: `node --test shopee/test/*.test.js`

Run: `npm --prefix avantracking/server run build --if-present`

Expected: every command exits 0.

- [ ] **Step 2: Verify Render staging secrets without printing values**

Confirm `DATABASE_URL` and `AVANTRACKING_DATABASE_URL` are both set and that the application guard reports different masked fingerprints. Stop if either variable is absent or fingerprints match.

- [ ] **Step 3: Retain a Neon staging recovery point**

Create or confirm a Neon branch/point-in-time recovery marker immediately before repair. Record its identifier outside the repository. Do not proceed without a recoverable pre-repair state.

- [ ] **Step 4: Run staging preflight**

Resolve the masked fingerprint without printing the URL:

```powershell
$shopeeTargetFingerprint = node -e "const {canonicalizeDatabaseTarget}=require('./avantracking/databaseTarget.cjs'); process.stdout.write(canonicalizeDatabaseTarget(process.env.DATABASE_URL).fingerprint)"
npm --workspace shopee run db:repair:avantracking -- "--expected-target=$shopeeTargetFingerprint"
```

Expected: eleven reference migrations present in Avantracking, known contamination signature present in Shopee, no unknown external FK, and `writeMode: false`.

- [ ] **Step 5: Apply staging repair**

Run:

```powershell
npm --workspace shopee run db:repair:avantracking -- --apply "--expected-target=$shopeeTargetFingerprint"
```

Expected: transaction committed, ten Avantracking-only tables quarantined when present, all known incompatible FKs and shared columns removed after snapshot, and eleven history rows quarantined and removed from active Shopee history.

- [ ] **Step 6: Apply and verify Shopee migrations**

Run: `npm --workspace shopee run db:migrate:deploy`

Run: `npm --workspace shopee run db:migrate:status`

Run: `npm --workspace shopee run db:schema:check`

Expected: 14 migrations applied, zero pending, schema check exits 0.

- [ ] **Step 7: Verify both applications against separate databases**

Run masked metadata reads for Shopee and Avantracking. Confirm Avantracking still has its full migration history and Shopee has Pricing V6 tables. Exercise health endpoints and representative read-only login/product/order queries in staging without triggering sync jobs.

- [ ] **Step 8: Repeat the approved sequence in production**

Use the production fingerprints and a fresh Neon recovery point. Repeat Steps 4-7 without reusing staging confirmation values. Stop on any fingerprint, preflight, row-count, migration, schema, or health mismatch.

- [ ] **Step 9: Final verification and commit any migration defect fix**

If no repository migration defect was found, no commit is needed for this step. If testing required a change to the Shopee compatibility migration, rerun the complete test suite and commit only that migration plus its regression test:

```bash
git add shopee/db/migrations/20260424230000_ensure_numeric_identity_compatibility/migration.sql shopee/test/avantrackingContamination.test.js
git commit -m "fix(shopee): restore numeric identity after contamination"
```
