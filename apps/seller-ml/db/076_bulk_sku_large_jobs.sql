CREATE TABLE IF NOT EXISTS ml.bulk_sku_exports (
  id text PRIMARY KEY,
  account_key text NOT NULL,
  account_label text NOT NULL,
  requested_by text NOT NULL,
  seller_id text NOT NULL,
  filter_status text NOT NULL CHECK (filter_status IN ('all','active','paused')),
  status text NOT NULL CHECK (status IN ('queued','running','finished','failed')),
  scanned_items integer NOT NULL DEFAULT 0,
  estimated_items integer NOT NULL DEFAULT 0,
  exported_rows integer NOT NULL DEFAULT 0,
  error_message text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS bulk_sku_exports_account_created_idx ON ml.bulk_sku_exports (account_key, requested_by, created_at DESC);
ALTER TABLE ml.bulk_sku_jobs DROP CONSTRAINT IF EXISTS bulk_sku_jobs_status_check;
ALTER TABLE ml.bulk_sku_jobs ADD CONSTRAINT bulk_sku_jobs_status_check CHECK (status IN ('preview_queued','previewing','preview','queued','running','finished','failed'));
ALTER TABLE ml.bulk_sku_jobs ADD COLUMN IF NOT EXISTS previewed_rows integer NOT NULL DEFAULT 0;
ALTER TABLE ml.bulk_sku_jobs ADD COLUMN IF NOT EXISTS last_row_number integer NOT NULL DEFAULT 0;
ALTER TABLE ml.bulk_sku_jobs ADD COLUMN IF NOT EXISTS ready_rows integer NOT NULL DEFAULT 0;
ALTER TABLE ml.bulk_sku_jobs ADD COLUMN IF NOT EXISTS error_message text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS bulk_sku_rows_state_idx ON ml.bulk_sku_job_rows (job_id, state);
