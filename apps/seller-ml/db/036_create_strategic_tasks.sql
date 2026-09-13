BEGIN;

CREATE TABLE IF NOT EXISTS ml_strategic_tasks (
  id BIGSERIAL PRIMARY KEY,
  item_id BIGINT REFERENCES ml_strategic_items(id) ON DELETE SET NULL,
  account_key TEXT NOT NULL,
  account_label TEXT,
  seller_id TEXT,
  mlb TEXT NOT NULL,
  sku TEXT,
  title_snapshot TEXT,
  thumbnail_snapshot TEXT,
  group_id BIGINT REFERENCES ml_strategic_groups(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT NOT NULL DEFAULT 'medium',
  task_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  task_notes TEXT,
  due_date DATE,
  assigned_to_user_id BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  completed_by_user_id BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  created_by_user_id BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  created_round_id BIGINT REFERENCES ml_strategic_rounds(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_ml_strategic_tasks_status CHECK (
    status IN ('pending', 'in_progress', 'review', 'completed', 'canceled')
  ),
  CONSTRAINT ck_ml_strategic_tasks_priority CHECK (
    priority IN ('low', 'medium', 'high')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ml_strategic_tasks_open_account_mlb
  ON ml_strategic_tasks (account_key, mlb)
  WHERE status IN ('pending', 'in_progress', 'review');

CREATE INDEX IF NOT EXISTS ix_ml_strategic_tasks_account_status_due
  ON ml_strategic_tasks (account_key, status, due_date, priority);

CREATE INDEX IF NOT EXISTS ix_ml_strategic_tasks_account_group
  ON ml_strategic_tasks (account_key, group_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_ml_strategic_tasks_assigned
  ON ml_strategic_tasks (assigned_to_user_id, status, due_date);

COMMIT;
