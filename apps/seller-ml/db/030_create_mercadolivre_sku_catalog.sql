CREATE SCHEMA IF NOT EXISTS ml;

CREATE TABLE IF NOT EXISTS ml.mercadolivre_sku_sync_runs (
  id bigserial PRIMARY KEY,
  account_key text NOT NULL,
  seller_id text NULL,
  status text NOT NULL DEFAULT 'queued',
  scope_statuses jsonb NOT NULL DEFAULT '["active"]'::jsonb,
  total_items integer NOT NULL DEFAULT 0,
  processed_items integer NOT NULL DEFAULT 0,
  total_skus integer NOT NULL DEFAULT 0,
  no_sku_items integer NOT NULL DEFAULT 0,
  error text NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_sku_sync_runs_account_created
  ON ml.mercadolivre_sku_sync_runs (account_key, created_at DESC);

CREATE TABLE IF NOT EXISTS ml.mercadolivre_sku_catalog (
  id bigserial PRIMARY KEY,
  account_key text NOT NULL,
  seller_id text NULL,
  reference_sku text NOT NULL,
  title_sample text NULL,
  thumbnail text NULL,
  item_count integer NOT NULL DEFAULT 0,
  active_item_count integer NOT NULL DEFAULT 0,
  paused_item_count integer NOT NULL DEFAULT 0,
  closed_item_count integer NOT NULL DEFAULT 0,
  stock_total integer NOT NULL DEFAULT 0,
  min_price numeric(14,2) NULL,
  max_price numeric(14,2) NULL,
  statuses jsonb NOT NULL DEFAULT '[]'::jsonb,
  categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  eans jsonb NOT NULL DEFAULT '[]'::jsonb,
  sample_mlbs jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz NULL,
  sync_run_id bigint NULL REFERENCES ml.mercadolivre_sku_sync_runs (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mercadolivre_sku_catalog_uq UNIQUE (account_key, reference_sku)
);

CREATE INDEX IF NOT EXISTS idx_ml_sku_catalog_account_active
  ON ml.mercadolivre_sku_catalog (account_key, is_active, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ml_sku_catalog_sku
  ON ml.mercadolivre_sku_catalog (reference_sku);

CREATE TABLE IF NOT EXISTS ml.mercadolivre_sku_catalog_items (
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
  thumbnail text NULL,
  permalink text NULL,
  eans jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_synced_at timestamptz NULL,
  sync_run_id bigint NULL REFERENCES ml.mercadolivre_sku_sync_runs (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mercadolivre_sku_catalog_items_uq UNIQUE (account_key, reference_sku, mlb, variation_id)
);

CREATE INDEX IF NOT EXISTS idx_ml_sku_catalog_items_account_sku
  ON ml.mercadolivre_sku_catalog_items (account_key, reference_sku);

CREATE INDEX IF NOT EXISTS idx_ml_sku_catalog_items_account_mlb
  ON ml.mercadolivre_sku_catalog_items (account_key, mlb);
