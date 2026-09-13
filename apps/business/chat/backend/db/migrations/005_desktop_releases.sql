CREATE TABLE IF NOT EXISTS desktop_releases (
  id SERIAL PRIMARY KEY,
  version VARCHAR(80) NOT NULL,
  platform VARCHAR(40) NOT NULL DEFAULT 'windows',
  filename VARCHAR(255) NOT NULL,
  content_type VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
  file_size BIGINT NOT NULL,
  sha256 VARCHAR(64) NOT NULL,
  binary_data BYTEA NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_desktop_releases_version ON desktop_releases (version);
CREATE INDEX IF NOT EXISTS ix_desktop_releases_platform ON desktop_releases (platform);
CREATE INDEX IF NOT EXISTS ix_desktop_releases_is_active ON desktop_releases (is_active);
CREATE INDEX IF NOT EXISTS ix_desktop_releases_created_at ON desktop_releases (created_at DESC);
