ALTER TABLE desktop_releases
  ALTER COLUMN binary_data DROP NOT NULL;

ALTER TABLE desktop_releases
  ADD COLUMN IF NOT EXISTS storage_mode VARCHAR(40) NOT NULL DEFAULT 'inline';

CREATE TABLE IF NOT EXISTS desktop_release_chunks (
  release_id INTEGER NOT NULL REFERENCES desktop_releases(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  data BYTEA NOT NULL,
  PRIMARY KEY (release_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS ix_desktop_release_chunks_release_id
  ON desktop_release_chunks (release_id);
