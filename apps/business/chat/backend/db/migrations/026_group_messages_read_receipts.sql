ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES chat_groups(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS ix_messages_group_id ON messages (group_id);

CREATE TABLE IF NOT EXISTS message_read_receipts (
    id BIGSERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_message_read_receipt_user UNIQUE (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS ix_message_read_receipts_message_id ON message_read_receipts (message_id);
CREATE INDEX IF NOT EXISTS ix_message_read_receipts_user_id ON message_read_receipts (user_id);