CREATE TABLE IF NOT EXISTS shopee_closed_month_order_measurements (
  shop_db_id INTEGER NOT NULL REFERENCES "Shop"(id),
  period_start DATE NOT NULL,
  period_end_exclusive DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  order_count INTEGER,
  range_code TEXT,
  source TEXT,
  error_message TEXT,
  measured_at TIMESTAMPTZ,
  hub_synced_at TIMESTAMPTZ,
  hub_sync_attempts INTEGER NOT NULL DEFAULT 0,
  hub_sync_error TEXT,
  started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (shop_db_id, period_start),
  CHECK (order_count IS NULL OR order_count >= 0)
);

CREATE INDEX IF NOT EXISTS shopee_closed_month_order_measurements_pending_idx
  ON shopee_closed_month_order_measurements (period_start, created_at)
  WHERE status = 'queued';
