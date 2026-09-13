ALTER TABLE users
  ADD COLUMN IF NOT EXISTS assistant_address_name VARCHAR(80);
