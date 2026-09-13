ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname VARCHAR(80);

CREATE INDEX IF NOT EXISTS ix_users_nickname ON users (nickname);
