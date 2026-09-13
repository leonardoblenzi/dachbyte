-- Migration: 20260424130000_ensure_company_multitenancy_base
-- Module: avantracking

BEGIN;

CREATE TABLE IF NOT EXISTS "Company" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "cnpj" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "databaseUrl" TEXT,
  "intelipostClientId" TEXT,
  "sswRequireCnpjs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "integrationCarrierExceptions" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "trayIntegrationEnabled" BOOLEAN NOT NULL DEFAULT true,
  "intelipostIntegrationEnabled" BOOLEAN NOT NULL DEFAULT true,
  "sswRequireEnabled" BOOLEAN NOT NULL DEFAULT true,
  "correiosIntegrationEnabled" BOOLEAN NOT NULL DEFAULT true,
  "blingIntegrationEnabled" BOOLEAN NOT NULL DEFAULT false,
  "magazordIntegrationEnabled" BOOLEAN NOT NULL DEFAULT false,
  "sysempIntegrationEnabled" BOOLEAN NOT NULL DEFAULT false,
  "magazordApiBaseUrl" TEXT,
  "magazordApiUser" TEXT,
  "magazordApiPassword" TEXT,
  "tenantGlobalId" TEXT,
  "documentType" TEXT,
  "documentNumber" TEXT,
  "anymarketIntegrationEnabled" BOOLEAN NOT NULL DEFAULT false,
  "anymarketApiBaseUrl" TEXT,
  "anymarketPlatform" TEXT,
  "anymarketToken" TEXT,
  "integrationManualStatuses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "integrationAutoSyncStatuses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Company"
  ADD COLUMN IF NOT EXISTS "cnpj" TEXT,
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "databaseUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "intelipostClientId" TEXT,
  ADD COLUMN IF NOT EXISTS "sswRequireCnpjs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "integrationCarrierExceptions" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "trayIntegrationEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "intelipostIntegrationEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "sswRequireEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "correiosIntegrationEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "blingIntegrationEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "magazordIntegrationEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "sysempIntegrationEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "magazordApiBaseUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "magazordApiUser" TEXT,
  ADD COLUMN IF NOT EXISTS "magazordApiPassword" TEXT,
  ADD COLUMN IF NOT EXISTS "tenantGlobalId" TEXT,
  ADD COLUMN IF NOT EXISTS "documentType" TEXT,
  ADD COLUMN IF NOT EXISTS "documentNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "anymarketIntegrationEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "anymarketApiBaseUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "anymarketPlatform" TEXT,
  ADD COLUMN IF NOT EXISTS "anymarketToken" TEXT,
  ADD COLUMN IF NOT EXISTS "integrationManualStatuses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "integrationAutoSyncStatuses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "Company"
SET
  "sswRequireCnpjs" = COALESCE("sswRequireCnpjs", ARRAY[]::TEXT[]),
  "integrationCarrierExceptions" = COALESCE("integrationCarrierExceptions", ARRAY[]::TEXT[]),
  "trayIntegrationEnabled" = COALESCE("trayIntegrationEnabled", true),
  "intelipostIntegrationEnabled" = COALESCE("intelipostIntegrationEnabled", true),
  "sswRequireEnabled" = COALESCE("sswRequireEnabled", true),
  "correiosIntegrationEnabled" = COALESCE("correiosIntegrationEnabled", true),
  "blingIntegrationEnabled" = COALESCE("blingIntegrationEnabled", false),
  "magazordIntegrationEnabled" = COALESCE("magazordIntegrationEnabled", false),
  "sysempIntegrationEnabled" = COALESCE("sysempIntegrationEnabled", false),
  "anymarketIntegrationEnabled" = COALESCE("anymarketIntegrationEnabled", false),
  "integrationManualStatuses" = COALESCE("integrationManualStatuses", ARRAY[]::TEXT[]),
  "integrationAutoSyncStatuses" = COALESCE("integrationAutoSyncStatuses", ARRAY[]::TEXT[]);

ALTER TABLE "Company"
  ALTER COLUMN "sswRequireCnpjs" SET DEFAULT ARRAY[]::TEXT[],
  ALTER COLUMN "trayIntegrationEnabled" SET DEFAULT true,
  ALTER COLUMN "intelipostIntegrationEnabled" SET DEFAULT true,
  ALTER COLUMN "sswRequireEnabled" SET DEFAULT true,
  ALTER COLUMN "correiosIntegrationEnabled" SET DEFAULT true,
  ALTER COLUMN "blingIntegrationEnabled" SET DEFAULT false,
  ALTER COLUMN "magazordIntegrationEnabled" SET DEFAULT false,
  ALTER COLUMN "sysempIntegrationEnabled" SET DEFAULT false,
  ALTER COLUMN "anymarketIntegrationEnabled" SET DEFAULT false,
  ALTER COLUMN "integrationManualStatuses" SET DEFAULT ARRAY[]::TEXT[],
  ALTER COLUMN "integrationAutoSyncStatuses" SET DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "Company"
  ALTER COLUMN "sswRequireCnpjs" SET NOT NULL,
  ALTER COLUMN "trayIntegrationEnabled" SET NOT NULL,
  ALTER COLUMN "intelipostIntegrationEnabled" SET NOT NULL,
  ALTER COLUMN "sswRequireEnabled" SET NOT NULL,
  ALTER COLUMN "correiosIntegrationEnabled" SET NOT NULL,
  ALTER COLUMN "blingIntegrationEnabled" SET NOT NULL,
  ALTER COLUMN "magazordIntegrationEnabled" SET NOT NULL,
  ALTER COLUMN "sysempIntegrationEnabled" SET NOT NULL,
  ALTER COLUMN "anymarketIntegrationEnabled" SET NOT NULL,
  ALTER COLUMN "integrationManualStatuses" SET NOT NULL,
  ALTER COLUMN "integrationAutoSyncStatuses" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "Company_tenantGlobalId_unique"
  ON "Company" ("tenantGlobalId");

CREATE INDEX IF NOT EXISTS "Company_document_idx"
  ON "Company" ("documentType", "documentNumber");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Company_documentType_check'
  ) THEN
    BEGIN
      ALTER TABLE "Company"
        ADD CONSTRAINT "Company_documentType_check"
        CHECK ("documentType" IS NULL OR "documentType" IN ('CNPJ', 'CPF'));
    EXCEPTION
      WHEN duplicate_object THEN
        RAISE NOTICE 'Company_documentType_check ja existe; seguindo.';
      WHEN OTHERS THEN
        RAISE NOTICE 'Nao foi possivel criar Company_documentType_check: %', SQLERRM;
    END;
  END IF;
END $$;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "companyId" TEXT;

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "companyId" TEXT;

DO $$
DECLARE
  user_company_udt TEXT;
  company_id_udt TEXT;
BEGIN
  IF to_regclass('public."User"') IS NOT NULL
    AND to_regclass('public."Company"') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'User_companyId_fkey'
    ) THEN
    SELECT udt_name
    INTO user_company_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'User'
      AND column_name = 'companyId';

    SELECT udt_name
    INTO company_id_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Company'
      AND column_name = 'id';

    IF COALESCE(user_company_udt, '') = COALESCE(company_id_udt, '') THEN
      BEGIN
        ALTER TABLE "User"
          ADD CONSTRAINT "User_companyId_fkey"
          FOREIGN KEY ("companyId") REFERENCES "Company"("id")
          ON DELETE SET NULL ON UPDATE CASCADE;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE NOTICE 'Nao foi possivel criar User_companyId_fkey: %', SQLERRM;
      END;
    ELSE
      RAISE NOTICE 'Pulando User_companyId_fkey por incompatibilidade de tipo: User.companyId=% / Company.id=%', user_company_udt, company_id_udt;
    END IF;
  END IF;
END $$;

DO $$
DECLARE
  order_company_udt TEXT;
  company_id_udt TEXT;
BEGIN
  IF to_regclass('public."Order"') IS NOT NULL
    AND to_regclass('public."Company"') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'Order_companyId_fkey'
    ) THEN
    SELECT udt_name
    INTO order_company_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Order'
      AND column_name = 'companyId';

    SELECT udt_name
    INTO company_id_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Company'
      AND column_name = 'id';

    IF COALESCE(order_company_udt, '') = COALESCE(company_id_udt, '') THEN
      BEGIN
        ALTER TABLE "Order"
          ADD CONSTRAINT "Order_companyId_fkey"
          FOREIGN KEY ("companyId") REFERENCES "Company"("id")
          ON DELETE SET NULL ON UPDATE CASCADE;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE NOTICE 'Nao foi possivel criar Order_companyId_fkey: %', SQLERRM;
      END;
    ELSE
      RAISE NOTICE 'Pulando Order_companyId_fkey por incompatibilidade de tipo: Order.companyId=% / Company.id=%', order_company_udt, company_id_udt;
    END IF;
  END IF;
END $$;

COMMIT;
