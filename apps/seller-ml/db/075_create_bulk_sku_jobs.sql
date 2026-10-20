CREATE SCHEMA IF NOT EXISTS ml;

CREATE TABLE IF NOT EXISTS ml.bulk_sku_jobs (
  id text PRIMARY KEY,
  account_key text NOT NULL,
  account_label text NOT NULL,
  requested_by text NOT NULL,
  status text NOT NULL CHECK (status IN ('preview', 'queued', 'running', 'finished', 'failed')),
  total_rows integer NOT NULL DEFAULT 0,
  processed_rows integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS ml.bulk_sku_job_rows (
  job_id text NOT NULL REFERENCES ml.bulk_sku_jobs(id) ON DELETE CASCADE,
  mlb text NOT NULL,
  variation_id text NOT NULL DEFAULT '',
  row_number integer NOT NULL,
  variation_name text NOT NULL DEFAULT '',
  old_sku text NOT NULL,
  new_sku text NOT NULL,
  ean_snapshot text NOT NULL DEFAULT '',
  state text NOT NULL,
  message text NOT NULL DEFAULT '',
  warning text NOT NULL DEFAULT '',
  response jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, row_number)
);

CREATE INDEX IF NOT EXISTS bulk_sku_jobs_account_created_idx
  ON ml.bulk_sku_jobs (account_key, created_at DESC);
CREATE INDEX IF NOT EXISTS bulk_sku_rows_target_idx
  ON ml.bulk_sku_job_rows (job_id, mlb, variation_id);
