ALTER TABLE desktop_releases
  ADD COLUMN IF NOT EXISTS storage_key VARCHAR(512);

CREATE INDEX IF NOT EXISTS ix_desktop_releases_storage_key
  ON desktop_releases (storage_key);
