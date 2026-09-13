CREATE SCHEMA IF NOT EXISTS ml;

CREATE TABLE IF NOT EXISTS ml.mercadolivre_sku_price_history (
  id bigserial PRIMARY KEY,
  account_key text NOT NULL,
  seller_id text NULL,
  reference_sku text NOT NULL,
  mlb text NOT NULL,
  variation_id text NOT NULL DEFAULT '',
  title text NULL,
  status text NULL,
  category_id text NULL,
  listing_type_id text NULL,
  price numeric(14,2) NULL,
  stock integer NOT NULL DEFAULT 0,
  snapshot_date date NOT NULL DEFAULT current_date,
  captured_at timestamptz NOT NULL DEFAULT now(),
  sync_run_id bigint NULL REFERENCES ml.mercadolivre_sku_sync_runs (id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'sku_catalog_sync',
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT mercadolivre_sku_price_history_uq
    UNIQUE (account_key, reference_sku, mlb, variation_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_ml_sku_price_history_account_sku_date
  ON ml.mercadolivre_sku_price_history (account_key, reference_sku, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_ml_sku_price_history_account_mlb_date
  ON ml.mercadolivre_sku_price_history (account_key, mlb, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_ml_sku_price_history_snapshot_date
  ON ml.mercadolivre_sku_price_history (snapshot_date DESC);
