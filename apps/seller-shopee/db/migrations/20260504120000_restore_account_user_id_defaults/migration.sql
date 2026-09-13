-- Migration: 20260504120000_restore_account_user_id_defaults
-- Module: shopee
-- Purpose: Restore numeric id defaults after legacy schema drift.

BEGIN;

DO $$
DECLARE
  max_id INTEGER;
BEGIN
  CREATE SEQUENCE IF NOT EXISTS "Account_id_seq";

  SELECT MAX(id) INTO max_id FROM "Account";
  IF max_id IS NULL THEN
    PERFORM setval('"Account_id_seq"', 1, false);
  ELSE
    PERFORM setval('"Account_id_seq"', max_id, true);
  END IF;

  ALTER TABLE "Account"
    ALTER COLUMN id SET DEFAULT nextval('"Account_id_seq"'::regclass);
  ALTER SEQUENCE "Account_id_seq" OWNED BY "Account".id;
END $$;

DO $$
DECLARE
  max_id INTEGER;
BEGIN
  CREATE SEQUENCE IF NOT EXISTS "User_id_seq";

  SELECT MAX(id) INTO max_id FROM "User";
  IF max_id IS NULL THEN
    PERFORM setval('"User_id_seq"', 1, false);
  ELSE
    PERFORM setval('"User_id_seq"', max_id, true);
  END IF;

  ALTER TABLE "User"
    ALTER COLUMN id SET DEFAULT nextval('"User_id_seq"'::regclass);
  ALTER SEQUENCE "User_id_seq" OWNED BY "User".id;
END $$;

COMMIT;
