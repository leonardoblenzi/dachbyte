ALTER TABLE messages ADD COLUMN IF NOT EXISTS archive_uid VARCHAR(64);
UPDATE messages
SET archive_uid = MD5(
  COALESCE(company_id, '') || ':' || id::text || ':' || COALESCE(timestamp::text, '')
)
WHERE archive_uid IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_archive_uid
  ON messages (archive_uid)
  WHERE archive_uid IS NOT NULL;

ALTER TABLE chat_history_backups
  ADD COLUMN IF NOT EXISTS format_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE chat_history_backups
  ADD COLUMN IF NOT EXISTS checksum_sha256 VARCHAR(64);
