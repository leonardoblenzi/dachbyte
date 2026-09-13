CREATE TABLE IF NOT EXISTS bolt_daily_ticket_summaries (
  id SERIAL PRIMARY KEY,
  company_id VARCHAR(36) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  summary_date VARCHAR(10) NOT NULL,
  open_ticket_count INTEGER NOT NULL DEFAULT 0,
  awaiting_reply_count INTEGER NOT NULL DEFAULT 0,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_bolt_daily_ticket_summary UNIQUE (company_id, user_id, summary_date)
);

CREATE INDEX IF NOT EXISTS ix_bolt_daily_ticket_summaries_company_id
  ON bolt_daily_ticket_summaries (company_id);

CREATE INDEX IF NOT EXISTS ix_bolt_daily_ticket_summaries_user_id
  ON bolt_daily_ticket_summaries (user_id);

CREATE INDEX IF NOT EXISTS ix_bolt_daily_ticket_summaries_summary_date
  ON bolt_daily_ticket_summaries (summary_date);