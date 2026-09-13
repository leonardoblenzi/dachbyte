CREATE TABLE IF NOT EXISTS chat_history_backups (
  id SERIAL PRIMARY KEY,
  company_id VARCHAR(36) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  original_size BIGINT NOT NULL DEFAULT 0,
  compressed_size BIGINT NOT NULL DEFAULT 0,
  compressed_data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_chat_history_backups_period UNIQUE (company_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS ix_chat_history_backups_company_period ON chat_history_backups (company_id, period_end DESC);
