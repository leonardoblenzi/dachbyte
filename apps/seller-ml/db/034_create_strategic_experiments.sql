BEGIN;

CREATE TABLE IF NOT EXISTS ml_strategic_items (
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
  price NUMERIC(14,2),
  stock INTEGER,
  active_round_id BIGINT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_ml_strategic_items_account_mlb UNIQUE (account_key, mlb)
);

CREATE TABLE IF NOT EXISTS ml_strategic_rounds (
  id BIGSERIAL PRIMARY KEY,
  item_id BIGINT NOT NULL REFERENCES ml_strategic_items(id) ON DELETE CASCADE,
  account_key TEXT NOT NULL,
  account_label TEXT,
  seller_id TEXT,
  mlb TEXT NOT NULL,
  sku TEXT,
  title_snapshot TEXT,
  thumbnail_snapshot TEXT,
  alteration_date DATE NOT NULL,
  review_due_date DATE NOT NULL,
  window_days INTEGER NOT NULL DEFAULT 7,
  status TEXT NOT NULL DEFAULT 'active',
  impact TEXT NOT NULL DEFAULT 'pending',
  confidence TEXT NOT NULL DEFAULT 'pending',
  change_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  change_notes TEXT,
  before_from DATE,
  before_to DATE,
  after_from DATE,
  after_to DATE,
  before_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  deltas JSONB NOT NULL DEFAULT '{}'::jsonb,
  insights JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  reviewed_at TIMESTAMPTZ,
  interrupted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_ml_strategic_rounds_status CHECK (
    status IN ('active', 'ready', 'completed', 'interrupted', 'failed')
  ),
  CONSTRAINT ck_ml_strategic_rounds_impact CHECK (
    impact IN ('pending', 'improved', 'worse', 'stable', 'inconclusive', 'interrupted', 'failed')
  ),
  CONSTRAINT ck_ml_strategic_rounds_confidence CHECK (
    confidence IN ('pending', 'low', 'medium', 'high')
  ),
  CONSTRAINT ck_ml_strategic_rounds_window CHECK (window_days BETWEEN 3 AND 30)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'fk_ml_strategic_items_active_round'
  ) THEN
    ALTER TABLE ml_strategic_items
      ADD CONSTRAINT fk_ml_strategic_items_active_round
      FOREIGN KEY (active_round_id)
      REFERENCES ml_strategic_rounds(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_ml_strategic_items_account_updated
  ON ml_strategic_items (account_key, updated_at DESC);

CREATE INDEX IF NOT EXISTS ix_ml_strategic_rounds_account_status
  ON ml_strategic_rounds (account_key, status, review_due_date);

CREATE INDEX IF NOT EXISTS ix_ml_strategic_rounds_due
  ON ml_strategic_rounds (status, review_due_date);

CREATE INDEX IF NOT EXISTS ix_ml_strategic_rounds_mlb_created
  ON ml_strategic_rounds (account_key, mlb, created_at DESC);

COMMIT;
