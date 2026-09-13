-- Migration: 20260429110000_user_receive_platform_emails
-- Module: avantracking

BEGIN;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "receivePlatformEmails" BOOLEAN NOT NULL DEFAULT TRUE;

COMMIT;
