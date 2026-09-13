-- Migration: 20260519150000_add_company_intelipost_api_key
-- Module: avantracking
-- Purpose: Store Intelipost API key per company for fallback tracking by invoice access key

BEGIN;

ALTER TABLE "Company"
  ADD COLUMN IF NOT EXISTS "intelipostApiKey" TEXT;

COMMIT;
