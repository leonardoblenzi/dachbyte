CREATE TABLE IF NOT EXISTS chat_stickers (
  id SERIAL PRIMARY KEY,
  company_id VARCHAR(36) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  image_data BYTEA NOT NULL,
  content_type VARCHAR(80) NOT NULL DEFAULT 'image/webp',
  file_size INTEGER NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_chat_stickers_owner
  ON chat_stickers(company_id, owner_user_id, is_active);
