-- Migration: 20260424154000_company_auto_sync_statuses
-- Module: avantracking

BEGIN;

ALTER TABLE "Company"
  ADD COLUMN IF NOT EXISTS "integrationAutoSyncStatuses" TEXT[] DEFAULT ARRAY[]::TEXT[];

COMMIT;
