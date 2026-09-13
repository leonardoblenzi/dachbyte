CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(80) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL UNIQUE,
  full_name VARCHAR(255) NOT NULL,
  hashed_password VARCHAR(255) NOT NULL,
  access_level VARCHAR(40) NOT NULL DEFAULT 'usuario',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_users_username ON users (username);
CREATE INDEX IF NOT EXISTS ix_users_email ON users (email);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message_type VARCHAR(40) NOT NULL DEFAULT 'text',
  file_path VARCHAR(500),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_read BOOLEAN NOT NULL DEFAULT FALSE
);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_path VARCHAR(500);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS timestamp TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

UPDATE messages
SET timestamp = COALESCE(timestamp, created_at, NOW())
WHERE timestamp IS NULL;

UPDATE messages
SET is_read = FALSE
WHERE is_read IS NULL;

ALTER TABLE messages ALTER COLUMN timestamp SET DEFAULT NOW();
ALTER TABLE messages ALTER COLUMN timestamp SET NOT NULL;
ALTER TABLE messages ALTER COLUMN is_read SET DEFAULT FALSE;
ALTER TABLE messages ALTER COLUMN is_read SET NOT NULL;

CREATE INDEX IF NOT EXISTS ix_messages_sender_id ON messages (sender_id);
CREATE INDEX IF NOT EXISTS ix_messages_receiver_id ON messages (receiver_id);
CREATE INDEX IF NOT EXISTS ix_messages_timestamp ON messages (timestamp);

CREATE TABLE IF NOT EXISTS file_uploads (
  id SERIAL PRIMARY KEY,
  filename VARCHAR(255) NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  file_size INTEGER NOT NULL,
  content_type VARCHAR(120) NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upload_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_file_uploads_uploaded_by ON file_uploads (uploaded_by);
