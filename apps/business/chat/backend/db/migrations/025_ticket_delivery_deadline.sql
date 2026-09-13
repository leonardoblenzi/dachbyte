ALTER TABLE tickets ADD COLUMN IF NOT EXISTS delivery_due_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS ix_tickets_delivery_due_at ON tickets (company_id, delivery_due_at);
