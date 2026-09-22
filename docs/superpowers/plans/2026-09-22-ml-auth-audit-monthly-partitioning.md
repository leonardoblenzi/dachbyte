# ML Auth Audit Monthly Partitioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the complete `ml.auth_audit` history to monthly PostgreSQL partitions while preserving the existing audit API, configurable Master retention rules, and safe operational rollback.

**Architecture:** A dedicated cutover CLI creates a shadow partitioned table, copies and validates the full history during a planned Seller/ML maintenance window, then swaps table names in a short transaction. A partition-maintenance service creates future months, drains the default partition, runs the existing configurable cleanup, and drops only partitions proven to contain no event still retained by the Master rules.

**Tech Stack:** Node.js CommonJS, `pg`, PostgreSQL 18, Docker Compose, Node built-in test runner, Restic/R2 backup.

---

## File map

| File | Responsibility |
| --- | --- |
| `apps/seller-ml/services/authAuditPartitionService.js` | Database-safe partition discovery, creation, validation and eligible-partition pruning. |
| `apps/seller-ml/services/authAuditPartitionScheduler.js` | Single-instance, timer-injected maintenance scheduler for the web process. |
| `apps/seller-ml/scripts/authAuditPartitionCutover.js` | Explicit CLI for preflight, full copy, validation, swap and rollback during the maintenance window. |
| `apps/seller-ml/db/072_auth_audit_partition_operations.sql` | Durable operation ledger for the cutover and monthly maintenance, independent of the audit table being swapped. |
| `apps/seller-ml/app.js` | Starts the partition scheduler after the current application schedulers. |
| `apps/seller-ml/tests/auth-audit-partition-service.test.js` | Unit tests for partition DDL, retention-safe pruning and result normalization. |
| `apps/seller-ml/tests/auth-audit-partition-scheduler.test.js` | Deterministic scheduling and no-overlap tests. |
| `apps/seller-ml/tests/auth-audit-partition-cutover.test.js` | Cutover CLI safety gates, SQL order and validation tests. |
| `infra/business-db-ops.sh` | Explicit commands for partition preflight, cutover and verification. |
| `infra/env/seller-ml.env.example` | Documents non-secret partition horizon and maintenance interval settings. |
| `docs/operations/ml-auth-audit-partition-cutover.md` | Production runbook with exact backup, maintenance, validation and rollback commands. |

## Safety invariants

- Do not put the 2+ GB copy inside `apps/seller-ml/db/migrate.js`; that runner wraps every SQL file in one transaction and is unsuitable for long-running shadow-table copy work.
- Do not hardcode 7/30/90-day event categories. Retention remains read dynamically from `ml.auth_audit_retention_rules`, including `*`.
- Do not drop a monthly partition merely from its name or age. Drop it only after the retention query proves that every row in it is expired under the current Master rules.
- Do not run the cutover while `seller-ml-web` or `seller-ml-worker` is writing. The CLI must refuse the swap unless `--confirm-cutover` is present and the operator has stopped those two services.
- Do not remove `ml.auth_audit_legacy_<UTC timestamp>` until 48 hours of verified production operation and a fresh successful Restic backup.

### Task 1: Capture the current schema contract and add the operation ledger

**Files:**
- Create: `apps/seller-ml/db/072_auth_audit_partition_operations.sql`
- Create: `apps/seller-ml/tests/auth-audit-partition-migration.test.js`

- [ ] **Step 1: Write the failing structural migration test**

Create `auth-audit-partition-migration.test.js` to read migration 072 and assert that it creates an operation ledger outside `auth_audit`, contains a unique `operation_id`, operation `kind`, `status`, UTC timestamps, JSONB details, and no delete/rewrite of `ml.auth_audit`.

```js
test("migration 072 records partition operations without rewriting audit history", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../db/072_auth_audit_partition_operations.sql"), "utf8");
  assert.match(sql, /create table if not exists ml\.auth_audit_partition_operations/i);
  assert.match(sql, /operation_id uuid not null unique/i);
  assert.match(sql, /kind text not null/i);
  assert.match(sql, /status text not null/i);
  assert.doesNotMatch(sql, /delete\s+from\s+ml\.auth_audit/i);
});
```

- [ ] **Step 2: Run the test and confirm it fails because migration 072 does not exist**

Run: `node --test apps/seller-ml/tests/auth-audit-partition-migration.test.js`

Expected: failure opening `072_auth_audit_partition_operations.sql`.

- [ ] **Step 3: Add the operation ledger migration**

Create the ledger with immutable operation identifiers and no FK to the table being replaced:

```sql
create table if not exists ml.auth_audit_partition_operations (
  id bigserial primary key,
  operation_id uuid not null unique,
  kind text not null check (kind in ('preflight', 'copy', 'validate', 'swap', 'rollback', 'maintenance')),
  status text not null check (status in ('started', 'completed', 'failed', 'skipped')),
  details jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists auth_audit_partition_operations_created_at_idx
  on ml.auth_audit_partition_operations (created_at desc);
```

- [ ] **Step 4: Run the migration test**

Run: `node --test apps/seller-ml/tests/auth-audit-partition-migration.test.js`

Expected: pass.

- [ ] **Step 5: Commit the ledger**

```bash
git add apps/seller-ml/db/072_auth_audit_partition_operations.sql apps/seller-ml/tests/auth-audit-partition-migration.test.js
git commit -m "Add ML audit partition operation ledger"
```

### Task 2: Build and test the partition service

**Files:**
- Create: `apps/seller-ml/services/authAuditPartitionService.js`
- Create: `apps/seller-ml/tests/auth-audit-partition-service.test.js`

- [ ] **Step 1: Write failing tests for the service contract**

Create tests with a fake `db.withClient`/`client.query` that require these exports:

```js
const {
  createAuthAuditPartitionService,
  monthBoundsUtc,
  partitionNameForMonth,
} = require("../services/authAuditPartitionService");

test("builds UTC monthly bounds and safe names", () => {
  assert.deepEqual(monthBoundsUtc(new Date("2026-09-22T12:00:00Z")), {
    from: "2026-09-01T00:00:00.000Z",
    to: "2026-10-01T00:00:00.000Z",
  });
  assert.equal(partitionNameForMonth(new Date("2026-09-01T00:00:00Z")), "auth_audit_2026_09");
});

test("never drops a partition until dynamic retention proves every row expired", async () => {
  const service = createAuthAuditPartitionService({ db: fakeDb({ retainedRows: 1 }) });
  const result = await service.pruneExpiredPartitions({ now: new Date("2027-01-01T00:00:00Z") });
  assert.equal(result.dropped.length, 0);
});
```

Also cover: 18 future months are created idempotently, a default partition exists, per-partition indexes include all current audit access paths, default rows are moved only after their target partition exists, advisory lock contention returns `skipped`, and every dynamic identifier is derived only from validated `YYYY_MM` values.

- [ ] **Step 2: Run the test and confirm RED**

Run: `node --test apps/seller-ml/tests/auth-audit-partition-service.test.js`

Expected: module-not-found failure.

- [ ] **Step 3: Implement deterministic partition helpers and service factory**

Use this public API:

```js
function createAuthAuditPartitionService({ db, clock = () => new Date(), monthsAhead = 18 } = {}) {
  return {
    inspectCurrentTable,
    ensurePartitions,
    drainDefaultPartition,
    pruneExpiredPartitions,
    verifyPartitionedAudit,
    recordOperation,
  };
}
```

`ensurePartitions` must use `pg_catalog` to verify `ml.auth_audit` has relkind `p` before issuing partition DDL. For each month, generate only identifiers matching `^auth_audit_\d{4}_\d{2}$`, create its range with parameterized timestamp values where PostgreSQL permits parameters, and create partition-local indexes for:

```sql
(created_at), (user_id), (evento), (empresa_id, created_at desc), (meli_conta_id, created_at desc),
upper(metadata ->> 'mlb_id') where metadata ? 'mlb_id',
upper(metadata ->> 'item_id') where metadata ? 'item_id',
upper(metadata ->> 'promotion_id') where metadata ? 'promotion_id'
```

`pruneExpiredPartitions` must first run the existing cleanup callback, then inspect each non-default child. For each candidate, query the child with the same dynamic rule semantics as cleanup:

```sql
select exists (
  select 1
    from %I a
    left join ml.auth_audit_retention_rules r on r.evento = a.evento
   cross join lateral (
      select retention_days
        from ml.auth_audit_retention_rules
       where evento = '*'
       limit 1
   ) fallback
   where a.created_at >= now() - make_interval(days => coalesce(r.retention_days, fallback.retention_days)::int)
) as has_retained_rows;
```

Only detach/drop a child when `has_retained_rows = false`; never drop `auth_audit_default` automatically.

- [ ] **Step 4: Run focused tests**

Run: `node --test apps/seller-ml/tests/auth-audit-partition-service.test.js`

Expected: all tests pass.

- [ ] **Step 5: Commit the service**

```bash
git add apps/seller-ml/services/authAuditPartitionService.js apps/seller-ml/tests/auth-audit-partition-service.test.js
git commit -m "Add ML audit partition maintenance service"
```

### Task 3: Add the scheduler without changing retention rules

**Files:**
- Create: `apps/seller-ml/services/authAuditPartitionScheduler.js`
- Modify: `apps/seller-ml/app.js:25-145`
- Modify: `infra/env/seller-ml.env.example`
- Create: `apps/seller-ml/tests/auth-audit-partition-scheduler.test.js`

- [ ] **Step 1: Write failing scheduler tests**

Test a factory with injected timer and maintenance runner:

```js
const { createAuthAuditPartitionScheduler } = require("../services/authAuditPartitionScheduler");

test("runs once at startup and never overlaps maintenance", async () => {
  const timers = fakeTimers();
  const calls = [];
  const scheduler = createAuthAuditPartitionScheduler({
    runMaintenance: async () => calls.push("run"),
    timers,
    intervalMs: 86400000,
  });
  scheduler.start();
  await timers.runNext();
  assert.deepEqual(calls, ["run"]);
});
```

Require disabled mode, configuration validation, error logging without crashing Seller/ML, `unref()` timers, and `stop()` cleanup.

- [ ] **Step 2: Run the scheduler test and confirm RED**

Run: `node --test apps/seller-ml/tests/auth-audit-partition-scheduler.test.js`

Expected: module-not-found failure.

- [ ] **Step 3: Implement and wire the scheduler**

Add environment settings with safe defaults that do not define retention:

```env
AUTH_AUDIT_PARTITION_MAINTENANCE_ENABLED=true
AUTH_AUDIT_PARTITION_MONTHS_AHEAD=18
AUTH_AUDIT_PARTITION_MAINTENANCE_INTERVAL_HOURS=24
```

In `app.js`, create the service using the normal ML database adapter and start one scheduler after the existing cleanup schedulers:

```js
const { startAuthAuditPartitionMaintenance } = require("./services/authAuditPartitionScheduler");
startAuthAuditPartitionMaintenance();
```

The maintenance cycle must call `ensurePartitions`, `drainDefaultPartition`, `cleanupAuthAudit`, then `pruneExpiredPartitions`, in that order. It must write an operation-ledger row for success, skip, and failure; it must not change `auth_audit_retention_rules`.

- [ ] **Step 4: Run focused tests and syntax checks**

Run:

```bash
node --test apps/seller-ml/tests/auth-audit-partition-scheduler.test.js apps/seller-ml/tests/auth-audit-partition-service.test.js
node --check apps/seller-ml/services/authAuditPartitionScheduler.js
node --check apps/seller-ml/app.js
```

Expected: all pass.

- [ ] **Step 5: Commit the scheduler**

```bash
git add apps/seller-ml/services/authAuditPartitionScheduler.js apps/seller-ml/app.js infra/env/seller-ml.env.example apps/seller-ml/tests/auth-audit-partition-scheduler.test.js
git commit -m "Schedule ML audit partition maintenance"
```

### Task 4: Implement the explicit full-history cutover CLI

**Files:**
- Create: `apps/seller-ml/scripts/authAuditPartitionCutover.js`
- Create: `apps/seller-ml/tests/auth-audit-partition-cutover.test.js`

- [ ] **Step 1: Write failing tests for command safety and operation order**

Require these commands: `preflight`, `copy`, `verify`, `swap`, `rollback`, and `status`. Test that `swap` and `rollback` refuse without the exact environment confirmation, that they acquire one advisory lock, and that the order is preflight → shadow table → monthly copy → validation → short rename transaction.

```js
test("refuses swap without explicit confirmation", async () => {
  await assert.rejects(
    runCutover({ command: "swap", env: {}, db: fakeDb() }),
    /AUTH_AUDIT_PARTITION_CONFIRM=SWAP/
  );
});

test("keeps legacy table until separate retention confirmation", async () => {
  const calls = [];
  await runCutover({ command: "swap", env: { AUTH_AUDIT_PARTITION_CONFIRM: "SWAP" }, db: fakeDb(calls) });
  assert.ok(calls.some((sql) => /rename to auth_audit_legacy_/i.test(sql)));
  assert.equal(calls.some((sql) => /drop table.*auth_audit_legacy/i.test(sql)), false);
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `node --test apps/seller-ml/tests/auth-audit-partition-cutover.test.js`

Expected: module-not-found failure.

- [ ] **Step 3: Implement preflight**

`preflight` must fail with clear output if any condition fails:

```sql
-- no inbound foreign keys to the table being swapped
select conrelid::regclass
  from pg_constraint
 where contype = 'f'
   and confrelid = 'ml.auth_audit'::regclass;

-- confirm expected columns and defaults
select attname, atttypid::regtype, attnotnull
  from pg_attribute
 where attrelid = 'ml.auth_audit'::regclass
   and attnum > 0 and not attisdropped;

-- capture counts and date range before copy
select count(*)::bigint, min(created_at), max(created_at), min(id), max(id)
  from ml.auth_audit;
```

The CLI must also check disk free space through `df` only when run in the container/VPS context, record image/version and database size, and insert an operation-ledger `preflight` record. It must not stop containers itself.

- [ ] **Step 4: Implement shadow table creation and monthly bulk copy**

Create `ml.auth_audit_partitioned_new` as:

```sql
create table ml.auth_audit_partitioned_new (
  id bigint generated by default as identity not null,
  user_id bigint references ml.usuarios(id) on delete set null,
  email text,
  evento text not null,
  status text not null default 'info',
  ip text,
  user_agent text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  empresa_id bigint references ml.empresas(id) on delete cascade,
  meli_conta_id bigint references ml.meli_contas(id) on delete cascade,
  primary key (created_at, id)
) partition by range (created_at);
```

Create every needed monthly child from the source `date_trunc('month', min(created_at))` through `date_trunc('month', max(created_at))`, plus 18 future months and `ml.auth_audit_default`. Copy one month at a time using the fixed column list:

```sql
insert into ml.auth_audit_partitioned_new
  (id, user_id, email, evento, status, ip, user_agent, metadata, created_at, empresa_id, meli_conta_id)
select id, user_id, email, evento, status, ip, user_agent, metadata, created_at, empresa_id, meli_conta_id
  from ml.auth_audit
 where created_at >= $1 and created_at < $2;
```

After all copy batches, set the identity sequence to `max(id)` and create the exact partition-local indexes tested in Task 2.

- [ ] **Step 5: Implement verification and short swap transaction**

`verify` must compare source and shadow per month and globally: row count, `min/max(id)`, `min/max(created_at)`, counts per `evento`, counts with `empresa_id`/`meli_conta_id`, and count of default-partition rows. Refuse `swap` on any mismatch.

With `AUTH_AUDIT_PARTITION_CONFIRM=SWAP`, `swap` must use one short transaction:

```sql
begin;
lock table ml.auth_audit in access exclusive mode;
alter table ml.auth_audit rename to auth_audit_legacy_<UTC suffix>;
alter table ml.auth_audit_partitioned_new rename to auth_audit;
commit;
```

Before commit, transfer grants matching the old table, ensure the new table’s sequence default is valid, and record the legacy relation name in `auth_audit_partition_operations`. Do not delete the legacy relation.

`rollback` requires `AUTH_AUDIT_PARTITION_CONFIRM=ROLLBACK`, refuses if new writes have occurred after swap unless the operator also supplies `AUTH_AUDIT_PARTITION_ALLOW_DATA_LOSS=YES`, and otherwise performs the inverse name swap under the same exclusive lock.

- [ ] **Step 6: Run tests and syntax check**

Run:

```bash
node --test apps/seller-ml/tests/auth-audit-partition-cutover.test.js apps/seller-ml/tests/auth-audit-partition-service.test.js
node --check apps/seller-ml/scripts/authAuditPartitionCutover.js
```

Expected: all pass.

- [ ] **Step 7: Commit the cutover CLI**

```bash
git add apps/seller-ml/scripts/authAuditPartitionCutover.js apps/seller-ml/tests/auth-audit-partition-cutover.test.js
git commit -m "Add ML audit partition cutover CLI"
```

### Task 5: Add explicit VPS operations and runbook

**Files:**
- Modify: `infra/business-db-ops.sh`
- Create: `docs/operations/ml-auth-audit-partition-cutover.md`
- Modify: `infra/env/seller-ml.env.example`

- [ ] **Step 1: Add partition operation commands to `business-db-ops.sh`**

Add commands that never run implicitly during ordinary deploy:

```bash
audit-partition-preflight)
  "${BASE[@]}" run --rm seller-ml-web node apps/seller-ml/scripts/authAuditPartitionCutover.js preflight
  ;;
audit-partition-copy)
  : "${AUTH_AUDIT_PARTITION_CONFIRM:?Set AUTH_AUDIT_PARTITION_CONFIRM=COPY}"
  "${BASE[@]}" run --rm seller-ml-web node apps/seller-ml/scripts/authAuditPartitionCutover.js copy
  ;;
audit-partition-verify)
  "${BASE[@]}" run --rm seller-ml-web node apps/seller-ml/scripts/authAuditPartitionCutover.js verify
  ;;
audit-partition-swap)
  : "${AUTH_AUDIT_PARTITION_CONFIRM:?Set AUTH_AUDIT_PARTITION_CONFIRM=SWAP}"
  "${BASE[@]}" run --rm seller-ml-web node apps/seller-ml/scripts/authAuditPartitionCutover.js swap
  ;;
```

Add `audit-partition-rollback` with the distinct `ROLLBACK` confirmation and no automatic restore command. Preserve every existing command unchanged.

- [ ] **Step 2: Document the production window**

Write the runbook in ordered sections: prerequisites, Restic initialization and restore proof, preflight, image build without restart, maintenance announcement, jobs drain, stop exact services, copy, verify, swap, start exact services, health checks, functional smoke, 48-hour observation, legacy drop, and rollback.

The required production commands must include:

```bash
cd /opt/dachbyte/repository/infra
./business-db-ops.sh backup
./business-db-ops.sh audit-partition-preflight
docker compose --env-file ./env/compose.env -f compose.vps.yml stop seller-ml-web seller-ml-worker
AUTH_AUDIT_PARTITION_CONFIRM=COPY ./business-db-ops.sh audit-partition-copy
./business-db-ops.sh audit-partition-verify
AUTH_AUDIT_PARTITION_CONFIRM=SWAP ./business-db-ops.sh audit-partition-swap
docker compose --env-file ./env/compose.env -f compose.vps.yml up -d --no-build seller-ml-web seller-ml-worker
```

The runbook must explicitly prohibit `docker compose down`, `VACUUM FULL`, pruning Docker data, and dropping the legacy table in the maintenance window.

- [ ] **Step 3: Verify shell syntax and documentation links**

Run:

```bash
bash -n infra/business-db-ops.sh
rg -n "auth_audit|AUTH_AUDIT_PARTITION_CONFIRM|backup|rollback" docs/operations/ml-auth-audit-partition-cutover.md infra/business-db-ops.sh
```

Expected: shell syntax exits 0 and all operational terms are found.

- [ ] **Step 4: Commit operational tooling**

```bash
git add infra/business-db-ops.sh infra/env/seller-ml.env.example docs/operations/ml-auth-audit-partition-cutover.md
git commit -m "Document ML audit partition cutover"
```

### Task 6: Run integration verification in an isolated PostgreSQL database

**Files:**
- Create: `apps/seller-ml/tests/auth-audit-partition-integration.test.js`
- Modify: `apps/seller-ml/tests/auth-audit-filters.test.js`

- [ ] **Step 1: Write a failing integration test gated by `ML_PARTITION_TEST_DATABASE_URL`**

The test must skip only when the isolated URL is absent. When it is supplied, create a disposable schema, insert rows spanning three months with: a critical event, a navigation event, an item-success event, a company-scoped event and a metadata identifier event. Run shadow copy/verify/swap against that schema.

```js
test("partitioned audit preserves current filter and retention contracts", { skip: !process.env.ML_PARTITION_TEST_DATABASE_URL }, async () => {
  const result = await cutover.run({ schema: disposableSchema, now: new Date("2026-09-22T00:00:00Z") });
  assert.equal(result.validation.matches, true);
  assert.equal(await listAuthEvents({ promotion_ids: "P-MLB456" }).then((r) => r.total), 1);
});
```

Also assert: delete of a company cascades its relational audit rows, dynamically shortening a retention rule prevents its old partition from being retained, an unexpired critical event prevents that partition drop, and default-partition movement preserves all values.

- [ ] **Step 2: Run focused unit tests before the isolated integration test**

Run:

```bash
node --test apps/seller-ml/tests/auth-audit-partition-migration.test.js apps/seller-ml/tests/auth-audit-partition-service.test.js apps/seller-ml/tests/auth-audit-partition-scheduler.test.js apps/seller-ml/tests/auth-audit-partition-cutover.test.js apps/seller-ml/tests/auth-audit-filters.test.js apps/seller-ml/tests/company-deletion-service.test.js
```

Expected: all pass.

- [ ] **Step 3: Run the isolated PostgreSQL integration test**

Run:

```bash
ML_PARTITION_TEST_DATABASE_URL='postgresql://…/dachbyte_ml_partition_test' \
node --test apps/seller-ml/tests/auth-audit-partition-integration.test.js
```

Expected: all assertions pass and the test removes only its disposable schema.

- [ ] **Step 4: Run the complete Seller/ML suite and record unrelated baseline failures**

Run: `node --test apps/seller-ml/tests/*.test.js`

Expected: partition-focused tests pass. The known unrelated failures in `promo-manual-range.test.js` must be recorded separately if they remain; do not change those files during this work.

- [ ] **Step 5: Commit integration coverage**

```bash
git add apps/seller-ml/tests/auth-audit-partition-integration.test.js apps/seller-ml/tests/auth-audit-filters.test.js
git commit -m "Verify partitioned ML audit behavior"
```

### Task 7: Execute the production cutover only after explicit operational approval

**Files:**
- Modify: `docs/operations/ml-auth-audit-partition-cutover.md` only if the executed release identifier or measured timings must be appended.

- [ ] **Step 1: Verify Git and backup readiness**

On the VPS, require a clean deployment checkout except documented local environment files, then run Restic backup and a tested restore proof. Record the snapshot timestamp and database size in the operation ledger through `preflight`.

- [ ] **Step 2: Prepare the exact image without restart**

```bash
cd /opt/dachbyte/repository
git pull --ff-only origin main
cd infra
docker compose --env-file ./env/compose.env -f compose.vps.yml build seller-ml-web seller-ml-worker
./business-db-ops.sh audit-partition-preflight
```

Expected: source table is non-partitioned, no inbound FKs, backup proof exists, free disk meets the calculated threshold, and preflight records `completed`.

- [ ] **Step 3: Enter maintenance and drain work**

Verify no active Seller ML job remains. Announce maintenance, then stop only these services:

```bash
docker compose --env-file ./env/compose.env -f compose.vps.yml stop seller-ml-web seller-ml-worker
docker compose --env-file ./env/compose.env -f compose.vps.yml ps seller-ml-web seller-ml-worker
```

Expected: both are stopped; Postgres, Redis, Gateway and unrelated modules remain running.

- [ ] **Step 4: Copy, verify and swap**

```bash
AUTH_AUDIT_PARTITION_CONFIRM=COPY ./business-db-ops.sh audit-partition-copy
./business-db-ops.sh audit-partition-verify
AUTH_AUDIT_PARTITION_CONFIRM=SWAP ./business-db-ops.sh audit-partition-swap
```

Expected: per-month/global validation matches exactly, swap records the legacy table name, and no legacy drop occurs.

- [ ] **Step 5: Restore runtime and perform smoke checks**

```bash
docker compose --env-file ./env/compose.env -f compose.vps.yml up -d --no-build seller-ml-web seller-ml-worker
docker compose --env-file ./env/compose.env -f compose.vps.yml ps seller-ml-web seller-ml-worker
curl -fsS https://dachbyte.tech/ml/health
```

Expected: web and worker become healthy, health returns `{"ok":true,"app":"seller-ml"}`, and QA confirms audit listing, identifier filters, export, retention panel and a non-destructive company-delete preview.

- [ ] **Step 6: Observe and then release legacy storage**

For 48 hours, inspect the operation ledger, default-partition count, error logs and database size. After a fresh Restic backup succeeds, use the CLI’s separate legacy-release command requiring `AUTH_AUDIT_PARTITION_CONFIRM=RELEASE_LEGACY` to drop only the exact legacy relation recorded by the swap. Confirm the reclaimed relation file size and do not execute `VACUUM FULL`.

- [ ] **Step 7: Commit the executed runbook evidence if changed**

```bash
git add docs/operations/ml-auth-audit-partition-cutover.md
git commit -m "Record ML audit partition cutover"
```

## Plan self-review

- Spec coverage: Tasks 1–4 implement operation state, table structure, future maintenance and complete-history cutover. Task 5 supplies controlled VPS execution. Task 6 validates correctness. Task 7 covers backup, maintenance, rollback and legacy release.
- No retention duration is encoded in partition drop logic; every retention decision queries the Master-managed rules.
- Names are consistent: `authAuditPartitionService`, `authAuditPartitionScheduler`, `authAuditPartitionCutover`, `AUTH_AUDIT_PARTITION_CONFIRM` and the `auth_audit_partition_operations` ledger are used consistently.
- The plan deliberately excludes changing event categories, cleaning Docker and running `VACUUM FULL`.
