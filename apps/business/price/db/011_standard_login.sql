ALTER TABLE volt_price.users
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

UPDATE volt_price.users
SET must_change_password = false
WHERE must_change_password IS NULL;

ALTER TABLE volt_price.users
  ALTER COLUMN must_change_password SET DEFAULT false;

ALTER TABLE volt_price.users
  ALTER COLUMN must_change_password SET NOT NULL;
