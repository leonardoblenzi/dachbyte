CREATE SCHEMA IF NOT EXISTS ml;

CREATE TABLE IF NOT EXISTS ml.reputation_snapshots (
  id bigserial PRIMARY KEY,
  account_key text NOT NULL,
  seller_id text NOT NULL DEFAULT '',
  meli_conta_id bigint NULL REFERENCES ml.meli_contas (id) ON DELETE SET NULL,
  snapshot_date date NOT NULL DEFAULT current_date,
  reputation_level text NULL,
  status_tone text NULL,
  claims_pct numeric(10,4) NOT NULL DEFAULT 0,
  claims_count integer NOT NULL DEFAULT 0,
  claims_limit numeric(10,4) NOT NULL DEFAULT 0,
  mediations_pct numeric(10,4) NOT NULL DEFAULT 0,
  mediations_count integer NOT NULL DEFAULT 0,
  mediations_limit numeric(10,4) NOT NULL DEFAULT 0,
  cancellations_pct numeric(10,4) NOT NULL DEFAULT 0,
  cancellations_count integer NOT NULL DEFAULT 0,
  cancellations_limit numeric(10,4) NOT NULL DEFAULT 0,
  delayed_pct numeric(10,4) NOT NULL DEFAULT 0,
  delayed_count integer NOT NULL DEFAULT 0,
  delayed_limit numeric(10,4) NOT NULL DEFAULT 0,
  top_products_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  intelligence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reputation_snapshots_unique_day UNIQUE (account_key, seller_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_reputation_snapshots_account_date
  ON ml.reputation_snapshots (account_key, seller_id, snapshot_date DESC);

