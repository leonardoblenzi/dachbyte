-- Migration: 20260513150000_add_jet_integration_company_fields
-- Module: avantracking

BEGIN;

ALTER TABLE "Company"
  ADD COLUMN IF NOT EXISTS "jetIntegrationEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "jetOrderLookupUrlTemplate" TEXT,
  ADD COLUMN IF NOT EXISTS "jetIntegrationKey" TEXT,
  ADD COLUMN IF NOT EXISTS "jetStoreId" TEXT,
  ADD COLUMN IF NOT EXISTS "jetUsername" TEXT,
  ADD COLUMN IF NOT EXISTS "jetPassword" TEXT,
  ADD COLUMN IF NOT EXISTS "jetBearerToken" TEXT;

UPDATE "Company"
SET "jetIntegrationEnabled" = COALESCE("jetIntegrationEnabled", false);

ALTER TABLE "Company"
  ALTER COLUMN "jetIntegrationEnabled" SET DEFAULT false,
  ALTER COLUMN "jetIntegrationEnabled" SET NOT NULL;

COMMIT;
