ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

UPDATE file_uploads
SET expires_at = COALESCE(upload_date, NOW()) + INTERVAL '15 days'
WHERE expires_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_file_uploads_expires_at ON file_uploads (expires_at);
