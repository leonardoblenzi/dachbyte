-- Durable commercial measurement outbox for new ML trial accounts. The worker
-- runs after account activation; failed API reads never become zero orders.
CREATE TABLE IF NOT EXISTS ml.ml_closed_month_order_measurements (
  account_id BIGINT NOT NULL REFERENCES ml.meli_contas(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end_exclusive DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  order_count INTEGER NULL CHECK (order_count >= 0),
  range_code TEXT NULL,
  source TEXT NULL,
  measured_at TIMESTAMPTZ NULL,
  error_message TEXT NULL,
  hub_synced_at TIMESTAMPTZ NULL,
  hub_sync_attempts INTEGER NOT NULL DEFAULT 0,
  hub_sync_error TEXT NULL,
  started_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, period_start),
  CHECK (period_end_exclusive > period_start)
);

CREATE INDEX IF NOT EXISTS ix_ml_closed_month_measurements_pending
  ON ml.ml_closed_month_order_measurements (status, created_at)
  WHERE status IN ('queued', 'running');
