-- Migration: 20260424120000_user_profile_settings
-- Module: avantracking

BEGIN;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "phone" TEXT,
  ADD COLUMN IF NOT EXISTS "birthDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "profileImageData" TEXT,
  ADD COLUMN IF NOT EXISTS "lastBirthdayCelebrationAt" TIMESTAMP(3);

COMMIT;
