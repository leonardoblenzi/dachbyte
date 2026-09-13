ALTER TABLE chat_stickers
  ADD COLUMN IF NOT EXISTS source_reference VARCHAR(160);

CREATE UNIQUE INDEX IF NOT EXISTS ux_chat_stickers_favorite_source
  ON chat_stickers(company_id, owner_user_id, source_reference)
  WHERE source_reference IS NOT NULL AND is_active = TRUE;
