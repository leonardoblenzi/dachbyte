CREATE INDEX IF NOT EXISTS ix_audit_logs_created_at
    ON audit_logs (created_at);
