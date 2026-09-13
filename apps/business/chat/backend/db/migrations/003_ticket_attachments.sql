ALTER TABLE tickets ADD COLUMN IF NOT EXISTS attachment_file_id INTEGER REFERENCES file_uploads(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_tickets_attachment_file_id ON tickets (attachment_file_id);
