-- Migration: 20260623113000_add_account_company_profile
-- Module: shopee
-- Purpose: Store admin master company profile data per Account/CNPJ.

BEGIN;

ALTER TABLE "Account"
  ADD COLUMN IF NOT EXISTS "companyPhotoUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "responsibleName" TEXT,
  ADD COLUMN IF NOT EXISTS "responsibleContact" TEXT;

COMMIT;
