# Shopee and Avantracking Database Isolation and Repair

## Context

Shopee and Avantracking have distinct Neon databases in local configuration. The integrated Render service, however, exposes the shared `DATABASE_URL` used by Shopee. Avantracking currently accepts `AVANTRACKING_DATABASE_URL` first and falls back to `DATABASE_URL` when the specific variable is absent.

The Shopee database history proves that eleven current Avantracking migrations were applied there on 2026-04-24. One of those migrations converted `User.id` to `TEXT` and added Avantracking structures and constraints to tables also used by Shopee. The Shopee migration `20260424230000_ensure_numeric_identity_compatibility` correctly blocks while this mixed schema remains.

The real Avantracking database already contains all eleven migrations found in the Shopee database, plus later Avantracking migrations. No transfer from Shopee to Avantracking is required.

## Goals

- Make Avantracking unable to connect to the Shopee database through a generic fallback.
- Detect identical Shopee and Avantracking targets even when one Neon URL uses the pooler hostname.
- Keep local, staging, and production startup behavior explicit and testable.
- Repair the Shopee database without deleting evidence or silently discarding contaminated values.
- Apply all pending Shopee migrations after the repair.
- Produce verification evidence for both databases and both Render environments.

## Non-goals

- Changing business behavior in Shopee or Avantracking.
- Moving valid Avantracking production data between databases.
- Deleting quarantine data during this work.
- Replacing the shared Render web service architecture.

## Runtime Isolation

Avantracking will require `AVANTRACKING_DATABASE_URL` for application access and migration execution. Its database layer and migration CLI will no longer use `DATABASE_URL` as a fallback.

The integrated adapter may load `DATABASE_URL` from an Avantracking-owned local `.env` file and expose it internally as `AVANTRACKING_DATABASE_URL`. It must never derive the Avantracking target from the process-wide `DATABASE_URL` populated by the Suite or Shopee.

At startup, the adapter will compare canonical database identities when both `DATABASE_URL` and `AVANTRACKING_DATABASE_URL` exist. Canonicalization will compare hostname after removing the Neon `-pooler` suffix, database name, and schema. Startup and migrations will fail before opening the Avantracking pool if both variables resolve to the same target. Logs must not include credentials or complete connection strings.

`render.yaml` will declare `AVANTRACKING_DATABASE_URL` as a secret (`sync: false`) for the integrated service. The existing dashboard values in staging and production remain authoritative.

## Repair Strategy

The repair will be implemented as a dedicated operational script, not as a normal application migration. It will default to dry-run and require an explicit apply flag plus confirmation of the expected Shopee database identity.

The script will use two connections:

- `DATABASE_URL`: target Shopee database.
- `AVANTRACKING_DATABASE_URL`: reference Avantracking database.

Before any write, it will verify:

- The targets are different after canonicalization.
- The Shopee target contains the known contamination signature.
- The Avantracking target contains all eleven misplaced migration names.
- Critical Shopee tables and row counts are readable.
- Existing IDs and foreign keys satisfy the planned conversions.
- No unknown external foreign key references would be affected.

All Shopee repair writes will run under one transaction and a PostgreSQL advisory lock.

## Quarantine

The repair will create a schema named `quarantine_avantracking_20260811`. It will contain:

- Copies of Avantracking-only tables found in the Shopee schema.
- Copies of values from Avantracking-only columns added to shared tables.
- A copy of the eleven misplaced migration-history rows.
- A repair manifest containing source table, row count, operation, and timestamp.

Avantracking-only tables will be moved to the quarantine schema only after their row counts and dependencies are captured. Shared Shopee tables will remain in `public`; only proven Avantracking columns and constraints will be removed or converted after their values are copied to quarantine.

The exact object list will be derived by comparing the eleven Avantracking migrations with the canonical Shopee legacy and current migrations. Objects with ambiguous ownership will stop the repair and require review.

## Identity Restoration

The repair must restore the numeric identity contract expected by Shopee:

- Preserve the mapping from every old textual `User.id` to its numeric replacement in quarantine.
- Update dependent Shopee references consistently.
- Handle Avantracking-added references before changing `User.id`.
- Recreate only canonical Shopee foreign keys and defaults.
- Validate referential integrity before committing.

The existing Shopee compatibility migration remains unchanged unless testing proves a repository bug independent of the contaminated environment. The repair script prepares the schema so the official migration can run normally.

## Migration History

After quarantining the corresponding rows, the repair will remove only the eleven confirmed Avantracking migration names from the Shopee `_davantti_sql_migrations` table. Shopee and unrelated migration records remain untouched.

The standard Shopee migration runner will then apply all pending Shopee migrations in order, including the Pricing V6 migration. No migration will be manually marked as applied.

## Deployment Order

1. Add isolation tests and implement the fail-closed Avantracking connection behavior.
2. Add the Render secret declaration and deploy isolation to staging.
3. Verify staging resolves Shopee and Avantracking to different canonical targets.
4. Run repair preflight against staging and retain its report.
5. Execute the staging repair transaction.
6. Apply Shopee migrations and run schema checks in staging.
7. Validate Shopee and Avantracking application health and representative reads.
8. Repeat the verified sequence in production.

Production repair must not begin if staging verification has unresolved failures.

## Tests and Verification

Automated tests will cover:

- Missing `AVANTRACKING_DATABASE_URL` fails closed.
- Generic `DATABASE_URL` is never selected by Avantracking.
- Direct and pooler Neon URLs for the same database are detected as identical.
- Different database targets are accepted.
- Migration execution receives only the Avantracking-specific target.
- Repair dry-run performs no writes.
- Preflight rejects missing reference migrations, unknown foreign keys, and target mismatch.
- Repair SQL is transactional and idempotent after successful completion.

Operational verification will record only masked database identities, migration counts, schema checks, row-count invariants, and application health. Credentials and full URLs will never be logged.

## Rollback

Any repair error rolls back the entire database transaction. After commit, quarantine data remains available for manual restoration. Neon point-in-time recovery or a pre-repair branch/snapshot should be retained as an additional recovery layer before production execution.

The code deployment can be rolled back independently, but Avantracking must never be allowed to resume the generic database fallback.

## Success Criteria

- Avantracking cannot start or migrate without its specific database variable.
- Shopee and Avantracking resolve to different canonical database identities in staging and production.
- The Shopee database no longer has active Avantracking-only objects or migration-history entries in `public`.
- The quarantine manifest and preserved data are complete.
- All Shopee migrations report applied with zero pending.
- Shopee schema checks, automated tests, and representative application reads pass.
- Avantracking keeps its existing migration history and remains healthy against its own database.
