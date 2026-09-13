BEGIN;

CREATE TABLE IF NOT EXISTS ml_stock_watch_items (
  id BIGSERIAL PRIMARY KEY,
  account_key TEXT NOT NULL,
  account_label TEXT,
  seller_id TEXT,
  mlb TEXT NOT NULL,
  sku TEXT,
  title TEXT,
  thumbnail TEXT,
  permalink TEXT,
  status TEXT,
  current_stock INTEGER NOT NULL DEFAULT 0,
  sales_30d INTEGER NOT NULL DEFAULT 0,
  sales_60d INTEGER NOT NULL DEFAULT 0,
  sales_90d INTEGER NOT NULL DEFAULT 0,
  avg_daily NUMERIC(14,4) NOT NULL DEFAULT 0,
  coverage_days NUMERIC(14,2),
  stockout_date DATE,
  trend TEXT,
  risk_level TEXT,
  turnover NUMERIC(14,4) NOT NULL DEFAULT 0,
  suggested_restock INTEGER NOT NULL DEFAULT 0,
  safety_stock INTEGER NOT NULL DEFAULT 0,
  purchase_status TEXT NOT NULL DEFAULT 'monitoring',
  expected_arrival_date DATE,
  last_stock_seen INTEGER NOT NULL DEFAULT 0,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_analyzed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_ml_stock_watch_account_mlb UNIQUE (account_key, mlb)
);

CREATE INDEX IF NOT EXISTS ix_ml_stock_watch_account_risk
  ON ml_stock_watch_items (account_key, risk_level, stockout_date);

CREATE INDEX IF NOT EXISTS ix_ml_stock_watch_arrival
  ON ml_stock_watch_items (account_key, purchase_status, expected_arrival_date);

CREATE TABLE IF NOT EXISTS ml_stock_watch_events (
  id BIGSERIAL PRIMARY KEY,
  account_key TEXT NOT NULL,
  mlb TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_ml_stock_watch_events_account_created
  ON ml_stock_watch_events (account_key, created_at DESC);

COMMIT;
