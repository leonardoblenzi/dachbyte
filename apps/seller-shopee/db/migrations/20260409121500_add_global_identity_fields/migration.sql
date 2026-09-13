-- Migration: 20260409121500_add_global_identity_fields
-- Module: shopee
-- Executada manualmente no banco definido em DATABASE_URL

BEGIN;

ALTER TABLE "Account"
  ADD COLUMN IF NOT EXISTS "tenantGlobalId" TEXT,
  ADD COLUMN IF NOT EXISTS "documentType" TEXT,
  ADD COLUMN IF NOT EXISTS "documentNumber" TEXT;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "userGlobalId" TEXT;

UPDATE "Account"
SET "documentType" = UPPER(TRIM("documentType"))
WHERE "documentType" IS NOT NULL;

UPDATE "Account"
SET "documentNumber" = NULLIF(REGEXP_REPLACE(COALESCE("documentNumber", ''), '[^0-9]', '', 'g'), '')
WHERE "documentNumber" IS NOT NULL;

UPDATE "Account"
SET "tenantGlobalId" = (md5(random()::text || clock_timestamp()::text || "id"::text)::uuid::text)
WHERE "tenantGlobalId" IS NULL;

UPDATE "User"
SET "userGlobalId" = (md5(random()::text || clock_timestamp()::text || "id"::text)::uuid::text)
WHERE "userGlobalId" IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Account_documentType_check'
  ) THEN
    ALTER TABLE "Account"
      ADD CONSTRAINT "Account_documentType_check"
      CHECK ("documentType" IS NULL OR "documentType" IN ('CNPJ', 'CPF'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "Account_tenantGlobalId_unique"
  ON "Account" ("tenantGlobalId")
  WHERE "tenantGlobalId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "Account_document_idx"
  ON "Account" ("documentType", "documentNumber")
  WHERE "documentType" IS NOT NULL
    AND "documentNumber" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "User_userGlobalId_unique"
  ON "User" ("userGlobalId")
  WHERE "userGlobalId" IS NOT NULL;

COMMIT;

