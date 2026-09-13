-- DAVANTTI / Neon Launch baseline
-- Read-only. Run against the target database before and after an optimization sprint.
-- Do not reset PostgreSQL statistics until the before/after window has been captured.

-- 1) Database-level transaction/temp/deadlock counters.
SELECT
  now() AS captured_at,
  current_database() AS database_name,
  numbackends,
  xact_commit,
  xact_rollback,
  blks_read,
  blks_hit,
  tup_returned,
  tup_fetched,
  tup_inserted,
  tup_updated,
  tup_deleted,
  temp_files,
  temp_bytes,
  deadlocks,
  stats_reset
FROM pg_stat_database
WHERE datname = current_database();

-- 2) Largest and busiest user tables.
SELECT
  schemaname,
  relname,
  n_live_tup,
  n_dead_tup,
  seq_scan,
  seq_tup_read,
  idx_scan,
  n_tup_ins,
  n_tup_upd,
  n_tup_del,
  pg_total_relation_size(relid) AS total_bytes,
  pg_relation_size(relid) AS heap_bytes,
  pg_indexes_size(relid) AS index_bytes
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC, relname
LIMIT 100;

-- 3) Current sessions. Queries are truncated to avoid dumping large/sensitive SQL text.
SELECT
  now() AS captured_at,
  application_name,
  usename,
  state,
  wait_event_type,
  wait_event,
  xact_start,
  query_start,
  left(query, 240) AS query_sample
FROM pg_stat_activity
WHERE datname = current_database()
  AND pid <> pg_backend_pid()
ORDER BY xact_start NULLS LAST, query_start NULLS LAST;

-- 4) Idle-in-transaction sessions: should normally be empty or short-lived.
SELECT
  pid,
  application_name,
  usename,
  state,
  now() - xact_start AS transaction_age,
  now() - state_change AS state_age,
  left(query, 240) AS query_sample
FROM pg_stat_activity
WHERE datname = current_database()
  AND state = 'idle in transaction'
ORDER BY xact_start;

-- 5) Index usage for large tables. Low idx_scan alone is not proof that an index is missing.
SELECT
  s.schemaname,
  s.relname,
  s.indexrelname,
  s.idx_scan,
  pg_relation_size(s.indexrelid) AS index_bytes
FROM pg_stat_user_indexes s
JOIN pg_stat_user_tables t
  ON t.relid = s.relid
ORDER BY pg_total_relation_size(t.relid) DESC, s.idx_scan DESC;

-- 6) Check whether pg_stat_statements is available before relying on query-level attribution.
SELECT EXISTS (
  SELECT 1
  FROM pg_extension
  WHERE extname = 'pg_stat_statements'
) AS pg_stat_statements_installed;

-- 7) Query-level hotspots, only when pg_stat_statements is installed.
-- Execute separately after step 6 returns true:
-- SELECT
--   calls,
--   total_exec_time,
--   mean_exec_time,
--   rows,
--   shared_blks_hit,
--   shared_blks_read,
--   temp_blks_read,
--   temp_blks_written,
--   left(query, 500) AS query_sample
-- FROM pg_stat_statements
-- ORDER BY total_exec_time DESC
-- LIMIT 50;
