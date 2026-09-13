ALTER TABLE tickets
    ADD COLUMN IF NOT EXISTS closed_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE tickets
    ADD COLUMN IF NOT EXISTS close_reason TEXT;

CREATE INDEX IF NOT EXISTS ix_tickets_closed_by_id
    ON tickets (closed_by_id);