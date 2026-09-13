ALTER TABLE ticket_messages
    ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES ticket_messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_ticket_messages_reply_to_id
    ON ticket_messages (reply_to_id);

CREATE TABLE IF NOT EXISTS ticket_message_reactions (
    id BIGSERIAL PRIMARY KEY,
    ticket_message_id INTEGER NOT NULL REFERENCES ticket_messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji VARCHAR(32) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_ticket_message_reaction_user_emoji UNIQUE (ticket_message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS ix_ticket_message_reactions_message_id
    ON ticket_message_reactions (ticket_message_id);

CREATE INDEX IF NOT EXISTS ix_ticket_message_reactions_user_id
    ON ticket_message_reactions (user_id);