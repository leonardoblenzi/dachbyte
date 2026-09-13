# Neon Launch optimization runbook

## Purpose

Use the same measurements before and after each database/performance sprint. The goal is to reduce Neon compute time and unnecessary database work without hiding operational failures or deleting business data prematurely.

## Baseline window

Prefer a comparable 24-hour window and a 7-day window. Record:

- Neon compute active time / CU-hours by project and branch;
- network transfer and logical storage;
- `xact_commit`, `xact_rollback`, `deadlocks`, `temp_bytes` and `temp_files` deltas;
- table-level `seq_scan`, `seq_tup_read`, `idx_scan`, inserts, updates and deletes;
- active connections and any `idle in transaction` sessions;
- p95/p99 application latency when available.

`docs/operations/neon-baseline.sql` is read-only and can be used for the PostgreSQL portion of the baseline.

## Sprint 1 — Volt Core acceptance criteria

The integration worker must:

1. avoid fixed 3-second polling when no work exists;
2. back off progressively to a default maximum idle interval of 10 minutes;
3. wake immediately after a locally committed integration job or outbox event is queued/retried;
4. preserve polling as a safety fallback for work created by another process;
5. preserve stale-job recovery and maintenance routines;
6. expose current poll interval / idle-cycle status through its existing status object;
7. pass the Volt Core test suite.

Expected database effect during genuinely idle periods:

- large reduction in scans of `integration_outbox_events` and `integration_jobs`;
- large reduction in transactions/commits per hour;
- continuous idle windows long enough for Neon autosuspend where no other application workload keeps the endpoint awake.

## Safety rules

- Do not reset PostgreSQL statistics before capturing the baseline.
- Do not infer that every sequential scan is bad; small relations are often correctly scanned sequentially.
- Do not add indexes without an identified query and plan evidence.
- Do not use `VACUUM FULL` as a routine optimization on production.
- Do not delete Neon branches/projects until Render connection targets have been verified.
- Do not commit Neon API keys, database URLs, passwords or signing secrets.

## Pull-request gate

The `Quality Gate` workflow runs Volt Core tests and runtime safety checks. After it is stable on `dev` and `voltdev`, repository administrators should configure branch protection/rulesets so this workflow is required before merging to those branches.
