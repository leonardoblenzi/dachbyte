-- Migration: 20260820143000_add_tray_refresh_token_expiry
-- Module: avantracking
-- Purpose: Persist the Tray refresh token expiration independently from the access token.

BEGIN;

ALTER TABLE "TrayAuth"
  ADD COLUMN IF NOT EXISTS "refreshTokenExpiresAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "TrayAuth_refreshTokenExpiresAt_idx"
  ON "TrayAuth" ("refreshTokenExpiresAt");

COMMIT;
