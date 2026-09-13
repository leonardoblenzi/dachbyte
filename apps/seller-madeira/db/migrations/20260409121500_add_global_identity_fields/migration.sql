-- Migration: 20260409121500_add_global_identity_fields
-- Module: MadeiraMadeira
-- Executada manualmente no banco definido em MAD_DIRECT_DATABASE_URL/MAD_DATABASE_URL

BEGIN;

ALTER TABLE "MadWorkspace"
  ADD COLUMN IF NOT EXISTS "tenantGlobalId" TEXT,
  ADD COLUMN IF NOT EXISTS "documentType" TEXT,
  ADD COLUMN IF NOT EXISTS "documentNumber" TEXT;

ALTER TABLE "MadUser"
  ADD COLUMN IF NOT EXISTS "userGlobalId" TEXT;

UPDATE "MadWorkspace"
SET "documentType" = UPPER(TRIM("documentType"))
WHERE "documentType" IS NOT NULL;

UPDATE "MadWorkspace"
SET "documentNumber" = NULLIF(REGEXP_REPLACE(COALESCE("documentNumber", ''), '[^0-9]', '', 'g'), '')
WHERE "documentNumber" IS NOT NULL;

UPDATE "MadWorkspace"
SET "tenantGlobalId" = (md5(random()::text || clock_timestamp()::text || "id"::text)::uuid::text)
WHERE "tenantGlobalId" IS NULL;

UPDATE "MadUser"
SET "userGlobalId" = (md5(random()::text || clock_timestamp()::text || "id"::text)::uuid::text)
WHERE "userGlobalId" IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'MadWorkspace_documentType_check'
  ) THEN
    ALTER TABLE "MadWorkspace"
      ADD CONSTRAINT "MadWorkspace_documentType_check"
      CHECK ("documentType" IS NULL OR "documentType" IN ('CNPJ', 'CPF'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "MadWorkspace_tenantGlobalId_unique"
  ON "MadWorkspace" ("tenantGlobalId")
  WHERE "tenantGlobalId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "MadWorkspace_document_idx"
  ON "MadWorkspace" ("documentType", "documentNumber")
  WHERE "documentType" IS NOT NULL
    AND "documentNumber" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "MadUser_userGlobalId_unique"
  ON "MadUser" ("userGlobalId")
  WHERE "userGlobalId" IS NOT NULL;

COMMIT;

