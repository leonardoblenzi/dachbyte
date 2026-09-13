ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_messages_reply_to_id
    ON messages (reply_to_id);

CREATE TABLE IF NOT EXISTS message_reactions (
    id BIGSERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji VARCHAR(32) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_message_reaction_user_emoji UNIQUE (message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS ix_message_reactions_message_id
    ON message_reactions (message_id);

CREATE INDEX IF NOT EXISTS ix_message_reactions_user_id
    ON message_reactions (user_id);