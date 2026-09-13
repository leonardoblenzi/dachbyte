-- Migration: 20260623110000_add_session_account_context
-- Module: shopee
-- Purpose: Allow master admin to enter an existing account while keeping the original user session.

BEGIN;

ALTER TABLE "Session"
  ADD COLUMN IF NOT EXISTS "accountContextId" INTEGER;

CREATE INDEX IF NOT EXISTS "Session_accountContextId_idx"
  ON "Session"("accountContextId");

COMMIT;
