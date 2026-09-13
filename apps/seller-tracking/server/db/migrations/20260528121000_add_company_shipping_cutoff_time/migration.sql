-- Migration: 20260528121000_add_company_shipping_cutoff_time
-- Module: avantracking
-- Purpose: Store per-company cutoff time used in shipping deadline calculations

BEGIN;

ALTER TABLE "Company"
  ADD COLUMN IF NOT EXISTS "shippingCutoffTime" TEXT;

UPDATE "Company"
SET "shippingCutoffTime" = '23:59'
WHERE COALESCE("shippingCutoffTime", '') = '';

COMMIT;
