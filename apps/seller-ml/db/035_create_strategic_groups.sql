BEGIN;

CREATE TABLE IF NOT EXISTS ml_strategic_groups (
  id BIGSERIAL PRIMARY KEY,
  account_key TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'blue',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_ml_strategic_groups_color CHECK (
    color IN ('blue', 'green', 'yellow', 'red', 'gray', 'cyan', 'violet')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ml_strategic_groups_account_name
  ON ml_strategic_groups (account_key, lower(name));

CREATE INDEX IF NOT EXISTS ix_ml_strategic_groups_account_active
  ON ml_strategic_groups (account_key, is_active, sort_order, name);

ALTER TABLE ml_strategic_items
  ADD COLUMN IF NOT EXISTS default_group_id BIGINT REFERENCES ml_strategic_groups(id) ON DELETE SET NULL;

ALTER TABLE ml_strategic_rounds
  ADD COLUMN IF NOT EXISTS group_id BIGINT REFERENCES ml_strategic_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_ml_strategic_items_default_group
  ON ml_strategic_items (account_key, default_group_id);

CREATE INDEX IF NOT EXISTS ix_ml_strategic_rounds_group
  ON ml_strategic_rounds (account_key, group_id, created_at DESC);

COMMIT;
