-- Migration: 20260424170000_ensure_tray_integration_tables
-- Module: avantracking

BEGIN;

CREATE TABLE IF NOT EXISTS "TrayAuth" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "storeName" TEXT,
  "apiAddress" TEXT NOT NULL,
  "accessToken" TEXT NOT NULL,
  "refreshToken" TEXT,
  "code" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "companyId" TEXT,
  CONSTRAINT "TrayAuth_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TrayAuth"
  ADD COLUMN IF NOT EXISTS "storeId" TEXT,
  ADD COLUMN IF NOT EXISTS "storeName" TEXT,
  ADD COLUMN IF NOT EXISTS "apiAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "accessToken" TEXT,
  ADD COLUMN IF NOT EXISTS "refreshToken" TEXT,
  ADD COLUMN IF NOT EXISTS "code" TEXT,
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "companyId" TEXT;

DROP INDEX IF EXISTS "TrayAuth_storeId_key";
CREATE INDEX IF NOT EXISTS "TrayAuth_storeId_idx" ON "TrayAuth"("storeId");
CREATE UNIQUE INDEX IF NOT EXISTS "TrayAuth_companyId_key" ON "TrayAuth"("companyId");

DO $$
DECLARE
  trayauth_company_udt TEXT;
  company_id_udt TEXT;
BEGIN
  IF to_regclass('public."TrayAuth"') IS NOT NULL
    AND to_regclass('public."Company"') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'TrayAuth_companyId_fkey'
    ) THEN
    SELECT udt_name
    INTO trayauth_company_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'TrayAuth'
      AND column_name = 'companyId';

    SELECT udt_name
    INTO company_id_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Company'
      AND column_name = 'id';

    IF COALESCE(trayauth_company_udt, '') = COALESCE(company_id_udt, '') THEN
      BEGIN
        ALTER TABLE "TrayAuth"
          ADD CONSTRAINT "TrayAuth_companyId_fkey"
          FOREIGN KEY ("companyId") REFERENCES "Company"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE NOTICE 'Nao foi possivel criar TrayAuth_companyId_fkey: %', SQLERRM;
      END;
    ELSE
      RAISE NOTICE 'Pulando TrayAuth_companyId_fkey por incompatibilidade de tipo: TrayAuth.companyId=% / Company.id=%', trayauth_company_udt, company_id_udt;
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "TrayCheckoutQuote" (
  "id" TEXT NOT NULL,
  "companyIdValue" TEXT,
  "trayStoreId" TEXT,
  "token" TEXT,
  "sessionId" TEXT,
  "originZipCode" TEXT,
  "destinationZipCode" TEXT,
  "productsRaw" JSONB,
  "productsHash" TEXT,
  "quotationId" TEXT NOT NULL,
  "shippingId" TEXT,
  "shipmentType" TEXT,
  "serviceCode" TEXT,
  "serviceName" TEXT,
  "integrator" TEXT,
  "quotedValue" DOUBLE PRECISION,
  "minPeriod" INTEGER,
  "maxPeriod" INTEGER,
  "selectedPossible" BOOLEAN,
  "snapshotData" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TrayCheckoutQuote_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TrayCheckoutQuote"
  ADD COLUMN IF NOT EXISTS "companyIdValue" TEXT,
  ADD COLUMN IF NOT EXISTS "trayStoreId" TEXT,
  ADD COLUMN IF NOT EXISTS "token" TEXT,
  ADD COLUMN IF NOT EXISTS "sessionId" TEXT,
  ADD COLUMN IF NOT EXISTS "originZipCode" TEXT,
  ADD COLUMN IF NOT EXISTS "destinationZipCode" TEXT,
  ADD COLUMN IF NOT EXISTS "productsRaw" JSONB,
  ADD COLUMN IF NOT EXISTS "productsHash" TEXT,
  ADD COLUMN IF NOT EXISTS "quotationId" TEXT,
  ADD COLUMN IF NOT EXISTS "shippingId" TEXT,
  ADD COLUMN IF NOT EXISTS "shipmentType" TEXT,
  ADD COLUMN IF NOT EXISTS "serviceCode" TEXT,
  ADD COLUMN IF NOT EXISTS "serviceName" TEXT,
  ADD COLUMN IF NOT EXISTS "integrator" TEXT,
  ADD COLUMN IF NOT EXISTS "quotedValue" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "minPeriod" INTEGER,
  ADD COLUMN IF NOT EXISTS "maxPeriod" INTEGER,
  ADD COLUMN IF NOT EXISTS "selectedPossible" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "snapshotData" JSONB,
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS "TrayCheckoutQuote_quotationId_key" ON "TrayCheckoutQuote"("quotationId");
CREATE INDEX IF NOT EXISTS "TrayCheckoutQuote_companyIdValue_idx" ON "TrayCheckoutQuote"("companyIdValue");
CREATE INDEX IF NOT EXISTS "TrayCheckoutQuote_trayStoreId_idx" ON "TrayCheckoutQuote"("trayStoreId");
CREATE INDEX IF NOT EXISTS "TrayCheckoutQuote_sessionId_idx" ON "TrayCheckoutQuote"("sessionId");
CREATE INDEX IF NOT EXISTS "TrayCheckoutQuote_productsHash_idx" ON "TrayCheckoutQuote"("productsHash");

DO $$
DECLARE
  trayquote_company_udt TEXT;
  company_id_udt TEXT;
BEGIN
  IF to_regclass('public."TrayCheckoutQuote"') IS NOT NULL
    AND to_regclass('public."Company"') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'TrayCheckoutQuote_companyIdValue_fkey'
    ) THEN
    SELECT udt_name
    INTO trayquote_company_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'TrayCheckoutQuote'
      AND column_name = 'companyIdValue';

    SELECT udt_name
    INTO company_id_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Company'
      AND column_name = 'id';

    IF COALESCE(trayquote_company_udt, '') = COALESCE(company_id_udt, '') THEN
      BEGIN
        ALTER TABLE "TrayCheckoutQuote"
          ADD CONSTRAINT "TrayCheckoutQuote_companyIdValue_fkey"
          FOREIGN KEY ("companyIdValue") REFERENCES "Company"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE NOTICE 'Nao foi possivel criar TrayCheckoutQuote_companyIdValue_fkey: %', SQLERRM;
      END;
    ELSE
      RAISE NOTICE 'Pulando TrayCheckoutQuote_companyIdValue_fkey por incompatibilidade de tipo: TrayCheckoutQuote.companyIdValue=% / Company.id=%', trayquote_company_udt, company_id_udt;
    END IF;
  END IF;
END $$;

COMMIT;
