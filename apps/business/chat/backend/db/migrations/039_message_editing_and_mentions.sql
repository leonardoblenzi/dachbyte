ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS allow_user_message_editing BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS message_edits (
    id BIGSERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    editor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    previous_content TEXT NOT NULL,
    edited_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_message_edits_message
    ON message_edits(message_id, edited_at);

CREATE TABLE IF NOT EXISTS message_mentions (
    id BIGSERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    read_at TIMESTAMP NULL,
    CONSTRAINT uq_message_mention_user UNIQUE (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS ix_message_mentions_user_unread
    ON message_mentions(user_id, read_at);
