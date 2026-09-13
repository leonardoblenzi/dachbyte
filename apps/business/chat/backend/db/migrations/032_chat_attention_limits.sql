CREATE TABLE IF NOT EXISTS chat_attention_limits (
  id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(36) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_date VARCHAR(10) NOT NULL,
  daily_count INTEGER NOT NULL DEFAULT 0,
  last_sent_at TIMESTAMP NULL,
  blocked_until TIMESTAMP NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_chat_attention_sender_receiver UNIQUE (company_id, sender_id, receiver_id)
);

CREATE INDEX IF NOT EXISTS ix_chat_attention_company_id ON chat_attention_limits(company_id);
CREATE INDEX IF NOT EXISTS ix_chat_attention_sender_id ON chat_attention_limits(sender_id);
CREATE INDEX IF NOT EXISTS ix_chat_attention_receiver_id ON chat_attention_limits(receiver_id);
CREATE INDEX IF NOT EXISTS ix_chat_attention_usage_date ON chat_attention_limits(usage_date);
CREATE INDEX IF NOT EXISTS ix_chat_attention_blocked_until ON chat_attention_limits(blocked_until);
