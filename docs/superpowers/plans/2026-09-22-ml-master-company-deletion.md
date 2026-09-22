# ML Master Company Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Master ML “Excluir em cascata” action remove all safely attributable company audit data, preserve shared-user identity history, and create a permanent read-only deletion receipt visible in the Master panel.

**Architecture:** A migration adds first-class company/account scope to `auth_audit` and creates an immutable receipt table. A dedicated service owns preview and transactional deletion, while a small job-inspector adapter blocks deletion when account jobs are active. The existing route becomes an HTTP adapter and the current companies page gains audit impact plus a paginated receipt history.

**Tech Stack:** Node.js 20, CommonJS, Express 5, PostgreSQL 18, `pg`, Bull/Redis, browser JavaScript, Node test runner.

---

## File map

- Create `apps/seller-ml/db/071_add_company_deletion_audit_scope.sql`: relational audit scope, backfill, indexes, receipt table.
- Create `apps/seller-ml/services/companyActiveJobsService.js`: read-only check of account-scoped jobs.
- Create `apps/seller-ml/services/companyDeletionService.js`: impact calculation, shared predicate, transactional deletion, receipt listing.
- Modify `apps/seller-ml/services/authAuditService.js`: populate relational audit scope for new events.
- Modify `apps/seller-ml/routes/adminEmpresasRoutes.js`: delegate preview/delete/history to the service and stop emitting the post-response deletion event.
- Modify `apps/seller-ml/views/admin-empresas.html`: audit impact and deletion-receipt history markup.
- Modify `apps/seller-ml/public/js/admin-empresas.js`: render impact, blockers, receipts, filters, and pagination.
- Create `apps/seller-ml/tests/company-deletion-migration.test.js`: migration contract.
- Create `apps/seller-ml/tests/company-deletion-service.test.js`: service behavior and rollback tests.
- Create `apps/seller-ml/tests/company-active-jobs.test.js`: job blocking contract.
- Create `apps/seller-ml/tests/company-deletion-ui.test.js`: route/UI contract and sensitive-field exclusions.

### Task 1: Add relational audit scope and immutable receipts

**Files:**
- Create: `apps/seller-ml/db/071_add_company_deletion_audit_scope.sql`
- Create: `apps/seller-ml/tests/company-deletion-migration.test.js`

- [ ] **Step 1: Write the failing migration contract test**

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const migrationPath = path.join(__dirname, "..", "db", "071_add_company_deletion_audit_scope.sql");

test("company deletion migration scopes audit and creates immutable receipts", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /alter table\s+ml\.auth_audit[\s\S]*empresa_id bigint/i);
  assert.match(sql, /meli_conta_id bigint/i);
  assert.match(sql, /references\s+ml\.empresas\s*\(id\)\s+on delete cascade/i);
  assert.match(sql, /references\s+ml\.meli_contas\s*\(id\)\s+on delete cascade/i);
  assert.match(sql, /create table if not exists\s+ml\.company_deletion_receipts/i);
  assert.match(sql, /request_id uuid not null unique/i);
  assert.doesNotMatch(sql, /access_token|refresh_token|user_agent|\bip\b/i);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test apps/seller-ml/tests/company-deletion-migration.test.js`

Expected: FAIL because `071_add_company_deletion_audit_scope.sql` does not exist.

- [ ] **Step 3: Create the migration**

The migration must:

```sql
BEGIN;

ALTER TABLE ml.auth_audit
  ADD COLUMN IF NOT EXISTS empresa_id bigint,
  ADD COLUMN IF NOT EXISTS meli_conta_id bigint;

UPDATE ml.auth_audit a
SET meli_conta_id = (a.metadata ->> 'meli_conta_id')::bigint
WHERE a.meli_conta_id IS NULL
  AND coalesce(a.metadata ->> 'meli_conta_id', '') ~ '^[1-9][0-9]*$'
  AND EXISTS (
    SELECT 1 FROM ml.meli_contas mc
    WHERE mc.id = (a.metadata ->> 'meli_conta_id')::bigint
  );

UPDATE ml.auth_audit a
SET empresa_id = CASE
  WHEN coalesce(a.metadata ->> 'empresa_id', '') ~ '^[1-9][0-9]*$'
    THEN (a.metadata ->> 'empresa_id')::bigint
  ELSE (a.metadata ->> 'company_id')::bigint
END
WHERE a.empresa_id IS NULL
  AND (
    coalesce(a.metadata ->> 'empresa_id', '') ~ '^[1-9][0-9]*$'
    OR coalesce(a.metadata ->> 'company_id', '') ~ '^[1-9][0-9]*$'
  )
  AND EXISTS (
    SELECT 1 FROM ml.empresas e
    WHERE e.id = CASE
      WHEN coalesce(a.metadata ->> 'empresa_id', '') ~ '^[1-9][0-9]*$'
        THEN (a.metadata ->> 'empresa_id')::bigint
      ELSE (a.metadata ->> 'company_id')::bigint
    END
  );

UPDATE ml.auth_audit a
SET empresa_id = mc.empresa_id
FROM ml.meli_contas mc
WHERE a.empresa_id IS NULL
  AND mc.id = a.meli_conta_id;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_audit_empresa_id_fkey') THEN
    ALTER TABLE ml.auth_audit
      ADD CONSTRAINT auth_audit_empresa_id_fkey
      FOREIGN KEY (empresa_id) REFERENCES ml.empresas(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_audit_meli_conta_id_fkey') THEN
    ALTER TABLE ml.auth_audit
      ADD CONSTRAINT auth_audit_meli_conta_id_fkey
      FOREIGN KEY (meli_conta_id) REFERENCES ml.meli_contas(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

ALTER TABLE ml.auth_audit VALIDATE CONSTRAINT auth_audit_empresa_id_fkey;
ALTER TABLE ml.auth_audit VALIDATE CONSTRAINT auth_audit_meli_conta_id_fkey;

CREATE INDEX IF NOT EXISTS auth_audit_empresa_created_idx
  ON ml.auth_audit (empresa_id, created_at DESC);
CREATE INDEX IF NOT EXISTS auth_audit_meli_conta_created_idx
  ON ml.auth_audit (meli_conta_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ml.company_deletion_receipts (
  id bigserial PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  deleted_company_id bigint NOT NULL,
  deleted_company_name text NOT NULL,
  deleted_tenant_global_id text,
  deleted_by_user_id bigint,
  deleted_by_email text,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  deleted_users_count integer NOT NULL CHECK (deleted_users_count >= 0),
  unlinked_users_count integer NOT NULL CHECK (unlinked_users_count >= 0),
  deleted_accounts_count integer NOT NULL CHECK (deleted_accounts_count >= 0),
  deleted_audit_events_count bigint NOT NULL CHECK (deleted_audit_events_count >= 0),
  status text NOT NULL CHECK (status = 'completed')
);

CREATE INDEX IF NOT EXISTS company_deletion_receipts_deleted_at_idx
  ON ml.company_deletion_receipts (deleted_at DESC);
CREATE INDEX IF NOT EXISTS company_deletion_receipts_company_name_idx
  ON ml.company_deletion_receipts (lower(deleted_company_name));

COMMIT;
```

- [ ] **Step 4: Verify GREEN and migration syntax contract**

Run: `node --test apps/seller-ml/tests/company-deletion-migration.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/seller-ml/db/071_add_company_deletion_audit_scope.sql apps/seller-ml/tests/company-deletion-migration.test.js
git commit -m "Add ML company deletion audit schema"
```

### Task 2: Persist relational scope for every new audit event

**Files:**
- Modify: `apps/seller-ml/services/authAuditService.js:1515`
- Modify: `apps/seller-ml/tests/auth-audit-filters.test.js`

- [ ] **Step 1: Add failing tests for explicit and metadata-derived scope**

Add tests that replace `db.query`, invoke `recordAuthEvent`, and assert the insert receives `empresa_id` and `meli_conta_id`. Cover explicit arguments and `metadata.company_id`, `metadata.empresa_id`, `metadata.meli_conta_id`, `metadata.accountKey`, and `metadata.account_key` when numeric.

```js
test("recordAuthEvent persists relational company and ML account scope", async (t) => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; };
  t.after(() => { db.query = originalQuery; });

  await recordAuthEvent({
    evento: "promotion_item_processed",
    empresaId: 41,
    meliContaId: 82,
    metadata: { mlb_id: "MLB1" },
  });

  assert.match(calls[0].sql, /empresa_id, meli_conta_id/);
  assert.equal(calls[0].params.at(-2), 41);
  assert.equal(calls[0].params.at(-1), 82);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test apps/seller-ml/tests/auth-audit-filters.test.js`

Expected: FAIL because `recordAuthEvent` does not accept or insert relational scope.

- [ ] **Step 3: Implement scope normalization and insertion**

Add a private `positiveBigintOrNull` helper. Extend `recordAuthEvent` with `empresaId` and `meliContaId`. Resolve fallbacks from metadata, then use a CTE to resolve `empresa_id` from `meli_contas` when only the account is present:

```js
async function recordAuthEvent({
  userId = null, email = null, evento, status = "info", ip = null,
  userAgent = null, metadata = null, empresaId = null, meliContaId = null,
}) {
  const scopedAccountId = positiveBigintOrNull(
    meliContaId ?? metadata?.meli_conta_id ?? metadata?.accountKey ?? metadata?.account_key,
  );
  const scopedCompanyId = positiveBigintOrNull(
    empresaId ?? metadata?.empresa_id ?? metadata?.company_id,
  );
  await db.query(
    `with scope as (
       select coalesce($8::bigint, mc.empresa_id) as empresa_id,
              $9::bigint as meli_conta_id
         from (select 1) seed
         left join meli_contas mc on mc.id = $9::bigint
     )
     insert into auth_audit
       (user_id, email, evento, status, ip, user_agent, metadata, empresa_id, meli_conta_id)
     select $1, $2, $3, $4, $5, $6, $7::jsonb, scope.empresa_id, scope.meli_conta_id
       from scope`,
    [userId, email, String(evento || "").trim().toLowerCase(),
     String(status || "info").trim().toLowerCase(), ip, userAgent,
     metadata ? JSON.stringify(metadata) : null, scopedCompanyId, scopedAccountId],
  );
}
```

- [ ] **Step 4: Run audit tests**

Run: `node --test apps/seller-ml/tests/auth-audit-filters.test.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/seller-ml/services/authAuditService.js apps/seller-ml/tests/auth-audit-filters.test.js
git commit -m "Persist company scope in ML audit events"
```

### Task 3: Add active-job deletion guard

**Files:**
- Create: `apps/seller-ml/services/companyActiveJobsService.js`
- Create: `apps/seller-ml/tests/company-active-jobs.test.js`

- [ ] **Step 1: Write failing provider-aggregation tests**

Test a factory that accepts providers, queries each account key, treats `active`, `waiting`, `delayed`, `paused`, `aguardando`, `processando`, and `cancelando` as blockers, ignores terminal states, and converts provider failures into a safe blocker named `inspection_failed`.

```js
test("active company jobs block deletion and terminal jobs do not", async () => {
  const service = createCompanyActiveJobsService({
    providers: [{
      name: "promo-jobs",
      list: async () => [
        { id: "1", status: "active" },
        { id: "2", status: "completed" },
      ],
    }],
  });
  const blockers = await service.listBlockers([{ id: 82 }]);
  assert.deepEqual(blockers, [{ queue: "promo-jobs", job_id: "1", state: "active", account_key: "82" }]);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test apps/seller-ml/tests/company-active-jobs.test.js`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement the service with injectable providers**

The default provider registry must cover the mutating services already present: promotion application, promotion removal, smart optimization, characteristics, listing deletion, wholesale price, mass model, and production-time changes. Use their public list methods and normalize their returned `state`/`status`; do not reach into private `JOBS` maps.

```js
const PromoJobsService = require("./promoJobsService");
const PromoBulkRemove = require("./promoBulkRemoveAdapter");
const PromoSmartOptimizer = require("./promoSmartOptimizerService");
const CaracteristicasJobsService = require("./caracteristicasJobsService");
const ExclusaoLoteJobService = require("./exclusaoLoteJobService");
const AtacadoJobsService = require("./atacadoJobsService");
const ModeloMassaJobsService = require("./modeloMassaJobsService");
const PrazoProducaoQueueService = require("./prazoProducaoQueueService");

function defaultProviders() {
  return [
    { name: "promo-jobs", list: (key) => PromoJobsService.listRecent(500, { accountKey: key }) },
    { name: "ml-promo-bulk-remove", list: (key) => PromoBulkRemove.listRecent(500, { accountKey: key }) },
    { name: "promo-smart-optimizer", list: (key) => PromoSmartOptimizer.listRecent(500, { accountKey: key }) },
    { name: "ml-caracteristicas", list: (key) => CaracteristicasJobsService.listRecent(500, { accountKey: key }) },
    { name: "ml-exclusao-lote", list: (key) => ExclusaoLoteJobService.listJobs(500, { accountKey: key }) },
    { name: "atacado", list: (key) => AtacadoJobsService.listRecent(500, { accountKey: key }) },
    { name: "modelo-massa", list: (key) => ModeloMassaJobsService.listRecent(500, { accountKey: key }) },
    { name: "prazo-producao", list: (key) => PrazoProducaoQueueService.listPrazoJobs(500, { accountKey: key }) },
  ];
}
```

Export:

```js
module.exports = {
  ACTIVE_STATES,
  createCompanyActiveJobsService,
  companyActiveJobsService: createCompanyActiveJobsService({ providers: defaultProviders() }),
};
```

Limit each provider query to 500 recent jobs per account. If inspection fails, return a blocker instead of allowing deletion.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test apps/seller-ml/tests/company-active-jobs.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/seller-ml/services/companyActiveJobsService.js apps/seller-ml/tests/company-active-jobs.test.js
git commit -m "Block ML company deletion with active jobs"
```

### Task 4: Build the transactional company-deletion service

**Files:**
- Create: `apps/seller-ml/services/companyDeletionService.js`
- Create: `apps/seller-ml/tests/company-deletion-service.test.js`

- [ ] **Step 1: Write failing tests for the shared audit predicate**

Use a fake client that records SQL and returns deterministic rows. Test that preview and delete both match relational columns, five legacy metadata keys, account IDs, and exclusive user IDs.

- [ ] **Step 2: Write failing tests for transaction semantics**

Cover these cases separately:

1. shared-user generic login remains;
2. shared-user account-scoped event is deleted;
3. exclusive-user identity event is deleted;
4. blocker returns `blocked` before `BEGIN` deletion work;
5. any query failure causes `ROLLBACK` and no receipt;
6. success inserts one receipt after actual deletion counts are known.

- [ ] **Step 3: Run and verify RED**

Run: `node --test apps/seller-ml/tests/company-deletion-service.test.js`

Expected: FAIL because the service does not exist.

- [ ] **Step 4: Implement one reusable audit scope**

Export `COMPANY_AUDIT_WHERE` and use it in both count and delete:

```sql
a.empresa_id = $1
OR a.meli_conta_id = ANY($2::bigint[])
OR coalesce(a.metadata ->> 'empresa_id', '') = $1::text
OR coalesce(a.metadata ->> 'company_id', '') = $1::text
OR coalesce(a.metadata ->> 'meli_conta_id', '') = ANY($3::text[])
OR coalesce(a.metadata ->> 'accountKey', '') = ANY($3::text[])
OR coalesce(a.metadata ->> 'account_key', '') = ANY($3::text[])
OR a.user_id = ANY($4::bigint[])
```

The service API must be:

```js
createCompanyDeletionService({ db, activeJobs, randomUUID }) => ({
  previewCompanyDeletion(companyId),
  deleteCompany({ companyId, actor }),
  listDeletionReceipts(filters),
})
```

`deleteCompany` must issue `BEGIN`, reload the company using `FOR UPDATE`, re-run the blocker check and impact calculation, delete `auth_audit` first, delete exclusive non-Master users second, delete the company third, insert the receipt fourth, and `COMMIT` last. Return `{ impact, deleted_company, deleted_users, deleted_audit_events, request_id }`.

- [ ] **Step 5: Add receipt listing**

Accept `page` (minimum 1), `limit` (10–100), `search`, `date_from`, `date_to`, and `operator`. Use parameterized SQL, `count(*)` plus `ORDER BY deleted_at DESC, id DESC`, and return `{ page, limit, total, receipts }`.

- [ ] **Step 6: Run and verify GREEN**

Run: `node --test apps/seller-ml/tests/company-deletion-service.test.js`

Expected: all service tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/seller-ml/services/companyDeletionService.js apps/seller-ml/tests/company-deletion-service.test.js
git commit -m "Add transactional ML company deletion service"
```

### Task 5: Wire the Master API without recreating tenant audit

**Files:**
- Modify: `apps/seller-ml/routes/adminEmpresasRoutes.js`
- Create: `apps/seller-ml/tests/company-deletion-ui.test.js`

- [ ] **Step 1: Write failing route contract tests**

Assert that:

- `GET /empresas/deletion-receipts` is declared before dynamic company routes;
- preview delegates to `previewCompanyDeletion`;
- delete delegates to `deleteCompany`;
- the delete route no longer attaches `createAuditAction({ evento: "admin_company_deleted" })`;
- HTTP 409 is returned with `active_jobs` when the service reports blockers.

- [ ] **Step 2: Run and verify RED**

Run: `node --test apps/seller-ml/tests/company-deletion-ui.test.js`

Expected: FAIL on missing history route and old delete middleware.

- [ ] **Step 3: Refactor the routes**

Instantiate the service once with `db` and `companyActiveJobsService`. Keep `ensureMasterOnly` and `adminWriteRateLimiter`. Return:

```js
// preview
res.json({ ok: true, ...impact });

// blocked delete
res.status(409).json({
  ok: false,
  error: "A empresa possui jobs ativos. Aguarde ou cancele as operacoes antes de excluir.",
  active_jobs: result.active_jobs,
});

// successful delete
res.json({ ok: true, ...result });
```

Pass the actor as `{ userId: Number(req.user?.uid) || null, email: req.user?.email || null }`. Do not create a success event in `auth_audit`; the receipt is canonical.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test apps/seller-ml/tests/company-deletion-ui.test.js apps/seller-ml/tests/company-deletion-service.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/seller-ml/routes/adminEmpresasRoutes.js apps/seller-ml/tests/company-deletion-ui.test.js
git commit -m "Use safe company deletion flow in ML Master"
```

### Task 6: Show audit impact and immutable deletion history

**Files:**
- Modify: `apps/seller-ml/views/admin-empresas.html`
- Modify: `apps/seller-ml/public/js/admin-empresas.js`
- Modify: `apps/seller-ml/tests/company-deletion-ui.test.js`

- [ ] **Step 1: Extend the failing UI contract**

Assert IDs `deletion-history-search`, `deletion-history-from`, `deletion-history-to`, `deletion-history-operator`, `deletion-history-body`, `deletion-history-prev`, and `deletion-history-next`; assert the script renders `deleted_audit_events_count`, `active_jobs`, and `request_id`; assert it never renders `access_token`, `refresh_token`, `user_agent`, or raw metadata.

- [ ] **Step 2: Run and verify RED**

Run: `node --test apps/seller-ml/tests/company-deletion-ui.test.js`

Expected: FAIL because the receipt history markup is absent.

- [ ] **Step 3: Add the history section and modal impact rows**

Place the history card below the current company card. Reuse existing table/button/input classes. Add a five-column table: Empresa, Data, Operador, Impacto, Request ID. Update the static deletion warning to state that company-scoped audit is erased and a minimal receipt is retained.

- [ ] **Step 4: Add client behavior**

Implement `loadDeletionReceipts`, `renderDeletionReceipts`, and filter pagination. In `renderDeleteImpact`, add rows for `Registros de auditoria` and `Jobs ativos`. Disable `delete-confirm` whenever `active_jobs.length > 0`. After successful deletion, show the returned audit count in the toast and reload both companies and receipts.

- [ ] **Step 5: Bump the asset version and verify GREEN**

Change the script query from `admin-empresas.js?v=3` to `v=4`.

Run: `node --check apps/seller-ml/public/js/admin-empresas.js`

Run: `node --test apps/seller-ml/tests/company-deletion-ui.test.js`

Expected: syntax check and tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/seller-ml/views/admin-empresas.html apps/seller-ml/public/js/admin-empresas.js apps/seller-ml/tests/company-deletion-ui.test.js
git commit -m "Show ML company deletion receipts in Master"
```

### Task 7: Run the complete Seller ML regression suite

**Files:**
- Modify only if a failing regression proves the new behavior requires it.

- [ ] **Step 1: Run focused tests**

```bash
node --test \
  apps/seller-ml/tests/company-deletion-migration.test.js \
  apps/seller-ml/tests/company-active-jobs.test.js \
  apps/seller-ml/tests/company-deletion-service.test.js \
  apps/seller-ml/tests/company-deletion-ui.test.js \
  apps/seller-ml/tests/auth-audit-filters.test.js
```

Expected: all focused tests PASS with zero warnings.

- [ ] **Step 2: Run all Seller ML tests**

Run: `node --test apps/seller-ml/tests/*.test.js`

Expected: all Seller ML tests PASS.

- [ ] **Step 3: Run repository contracts**

Run: `node --test tests/*.test.js`

Expected: all root contracts PASS.

- [ ] **Step 4: Verify diff quality**

Run: `git diff --check`

Run: `git status --short`

Expected: no whitespace errors; only intended implementation files are modified. Leave the existing untracked `.codex/` directory untouched.

- [ ] **Step 5: Commit any test-only corrections**

```bash
git add apps/seller-ml/tests apps/seller-ml/services apps/seller-ml/routes apps/seller-ml/views apps/seller-ml/public/js apps/seller-ml/db
git commit -m "Verify ML company deletion workflow"
```

Skip this commit if the tree is already clean.

### Task 8: Deploy with backup, migration, and non-destructive production validation

**Files:**
- No source changes.

- [ ] **Step 1: Push the verified main branch**

Run: `git push dachbyte main`

Expected: remote `main` advances to the verified implementation commit.

- [ ] **Step 2: Create a VPS backup before migration**

On the VPS:

```bash
cd /opt/dachbyte/repository
git pull --ff-only dachbyte main
cd infra
./business-db-ops.sh backup
```

Expected: backup finishes successfully and reports the restic snapshot ID. Stop if backup configuration is unavailable; do not run the migration without a recoverable database snapshot.

- [ ] **Step 3: Apply the migration**

```bash
docker compose --env-file ./env/compose.env -f compose.vps.yml \
  run --rm seller-ml-web node apps/seller-ml/db/migrate.js
```

Expected: migration `071_add_company_deletion_audit_scope.sql` reports success.

- [ ] **Step 4: Rebuild the web and worker containers**

```bash
docker compose --env-file ./env/compose.env -f compose.vps.yml \
  up -d --build --force-recreate --no-deps seller-ml-web seller-ml-worker
docker compose --env-file ./env/compose.env -f compose.vps.yml \
  ps seller-ml-web seller-ml-worker
```

Expected: both containers become healthy.

- [ ] **Step 5: Validate the Master preview without deleting**

Open Mpozenato and Granbelo in the Master panel. Confirm that each preview shows users, accounts, audit count, and zero active-job blockers. Compare the API preview count with a read-only SQL count using the exact `COMPANY_AUDIT_WHERE` predicate.

- [ ] **Step 6: Perform the first real deletion**

Choose one ended-contract company whose preview has zero blockers. Capture the preview response and then confirm deletion once in the Master UI. Verify:

```sql
SELECT count(*) FROM ml.empresas WHERE id = :deleted_company_id;
SELECT count(*) FROM ml.auth_audit
 WHERE empresa_id = :deleted_company_id
    OR meli_conta_id = ANY(:deleted_account_ids);
SELECT * FROM ml.company_deletion_receipts
 WHERE request_id = :request_id;
```

Expected: company count `0`, scoped audit count `0`, exactly one receipt with the same counts returned by the DELETE response.

- [ ] **Step 7: Delete the second ended-contract company**

Repeat the preview and verification for the second company only after the first deletion passes every check. Confirm shared users remain linked to their other companies.

- [ ] **Step 8: Record operational evidence**

Record the deployed commit, migration result, backup snapshot ID, request IDs, deletion counts, and verification queries in the project’s Obsidian operational note. Do not copy deleted payloads or credentials into the vault.

---

## Rollback boundary

Application rollback is the previous Docker image/commit. Database rollback must not drop receipt or scope columns after real deletions have occurred; restore from the pre-migration backup only if the migration/deploy fails before any production deletion. Once a company has been deleted successfully, recovery requires the validated database backup and is a deliberate data-restoration operation.
