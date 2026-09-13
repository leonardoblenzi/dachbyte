ALTER TABLE desktop_releases ALTER COLUMN binary_data DROP NOT NULL;
ALTER TABLE desktop_releases ADD COLUMN IF NOT EXISTS storage_mode VARCHAR(40) NOT NULL DEFAULT 'inline';

CREATE TABLE IF NOT EXISTS desktop_release_chunks (
  release_id INTEGER NOT NULL REFERENCES desktop_releases(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  data BYTEA NOT NULL,
  PRIMARY KEY (release_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS ix_desktop_release_chunks_release_id
  ON desktop_release_chunks (release_id);

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS rating_score INTEGER;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS rating_comment TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS rated_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS ticket_messages (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  file_id INTEGER REFERENCES file_uploads(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_ticket_messages_ticket_id ON ticket_messages (ticket_id);
CREATE INDEX IF NOT EXISTS ix_ticket_messages_sender_id ON ticket_messages (sender_id);
CREATE INDEX IF NOT EXISTS ix_ticket_messages_created_at ON ticket_messages (created_at);
