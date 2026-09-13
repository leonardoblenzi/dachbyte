CREATE TABLE IF NOT EXISTS chat_groups (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  department VARCHAR(100),
  created_by_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_chat_groups_name ON chat_groups (name);
CREATE INDEX IF NOT EXISTS ix_chat_groups_department ON chat_groups (department);
CREATE INDEX IF NOT EXISTS ix_chat_groups_created_by ON chat_groups (created_by_id);
