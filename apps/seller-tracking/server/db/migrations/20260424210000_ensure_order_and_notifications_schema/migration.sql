-- Migration: 20260424210000_ensure_order_and_notifications_schema
-- Module: avantracking
-- Purpose: Ensure Order table exists with orderNumber column and SyncNotification table exists

BEGIN;

-- Create Carrier table if it doesn't exist
CREATE TABLE IF NOT EXISTS "Carrier" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL UNIQUE,
  "apiType" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Carrier_pkey" PRIMARY KEY ("id")
);

-- Create/Ensure Order table with all required columns
CREATE TABLE IF NOT EXISTS "Order" (
  "id" TEXT NOT NULL,
  "orderNumber" TEXT NOT NULL,
  "invoiceNumber" TEXT,
  "trackingCode" TEXT,
  "customerName" TEXT NOT NULL,
  "corporateName" TEXT,
  "cpf" TEXT,
  "cnpj" TEXT,
  "phone" TEXT,
  "mobile" TEXT,
  "salesChannel" TEXT NOT NULL,
  "freightType" TEXT,
  "freightValue" FLOAT8,
  "quotedFreightValue" FLOAT8,
  "quotedFreightDate" TIMESTAMP(3),
  "quotedFreightDetails" JSONB,
  "originalQuotedFreightValue" FLOAT8,
  "originalQuotedFreightDate" TIMESTAMP(3),
  "originalQuotedFreightDetails" JSONB,
  "originalQuotedFreightQuotationId" TEXT,
  "recalculatedFreightValue" FLOAT8,
  "recalculatedFreightDate" TIMESTAMP(3),
  "recalculatedFreightDetails" JSONB,
  "shippingDate" TIMESTAMP(3),
  "address" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "complement" TEXT,
  "neighborhood" TEXT NOT NULL,
  "city" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "zipCode" TEXT NOT NULL,
  "totalValue" FLOAT8 NOT NULL,
  "recipient" TEXT,
  "maxShippingDeadline" TIMESTAMP(3),
  "estimatedDeliveryDate" TIMESTAMP(3),
  "carrierEstimatedDeliveryDate" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "isDelayed" BOOLEAN NOT NULL DEFAULT false,
  "isArchived" BOOLEAN NOT NULL DEFAULT false,
  "archivedAt" TIMESTAMP(3),
  "manualCustomStatus" TEXT,
  "observation" TEXT,
  "lastApiSync" TIMESTAMP(3),
  "lastUpdate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastApiError" TEXT,
  "apiRawPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "carrierId" TEXT,
  "createdById" TEXT,
  "companyId" TEXT,
  CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- Add missing columns to Order if they don't exist
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "orderNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "invoiceNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "trackingCode" TEXT,
  ADD COLUMN IF NOT EXISTS "customerName" TEXT,
  ADD COLUMN IF NOT EXISTS "corporateName" TEXT,
  ADD COLUMN IF NOT EXISTS "cpf" TEXT,
  ADD COLUMN IF NOT EXISTS "cnpj" TEXT,
  ADD COLUMN IF NOT EXISTS "phone" TEXT,
  ADD COLUMN IF NOT EXISTS "mobile" TEXT,
  ADD COLUMN IF NOT EXISTS "salesChannel" TEXT,
  ADD COLUMN IF NOT EXISTS "freightType" TEXT,
  ADD COLUMN IF NOT EXISTS "freightValue" FLOAT8,
  ADD COLUMN IF NOT EXISTS "quotedFreightValue" FLOAT8,
  ADD COLUMN IF NOT EXISTS "quotedFreightDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "quotedFreightDetails" JSONB,
  ADD COLUMN IF NOT EXISTS "originalQuotedFreightValue" FLOAT8,
  ADD COLUMN IF NOT EXISTS "originalQuotedFreightDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "originalQuotedFreightDetails" JSONB,
  ADD COLUMN IF NOT EXISTS "originalQuotedFreightQuotationId" TEXT,
  ADD COLUMN IF NOT EXISTS "recalculatedFreightValue" FLOAT8,
  ADD COLUMN IF NOT EXISTS "recalculatedFreightDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "recalculatedFreightDetails" JSONB,
  ADD COLUMN IF NOT EXISTS "shippingDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "address" TEXT,
  ADD COLUMN IF NOT EXISTS "number" TEXT,
  ADD COLUMN IF NOT EXISTS "complement" TEXT,
  ADD COLUMN IF NOT EXISTS "neighborhood" TEXT,
  ADD COLUMN IF NOT EXISTS "city" TEXT,
  ADD COLUMN IF NOT EXISTS "state" TEXT,
  ADD COLUMN IF NOT EXISTS "zipCode" TEXT,
  ADD COLUMN IF NOT EXISTS "totalValue" FLOAT8,
  ADD COLUMN IF NOT EXISTS "recipient" TEXT,
  ADD COLUMN IF NOT EXISTS "maxShippingDeadline" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "estimatedDeliveryDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "carrierEstimatedDeliveryDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "isDelayed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "isArchived" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "manualCustomStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "observation" TEXT,
  ADD COLUMN IF NOT EXISTS "lastApiSync" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastUpdate" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "lastApiError" TEXT,
  ADD COLUMN IF NOT EXISTS "apiRawPayload" JSONB,
  ADD COLUMN IF NOT EXISTS "carrierId" TEXT,
  ADD COLUMN IF NOT EXISTS "createdById" TEXT,
  ADD COLUMN IF NOT EXISTS "companyId" TEXT;

-- Create indexes on Order table
CREATE INDEX IF NOT EXISTS "Order_status_idx" ON "Order"("status");
CREATE INDEX IF NOT EXISTS "Order_orderNumber_idx" ON "Order"("orderNumber");
CREATE INDEX IF NOT EXISTS "Order_invoiceNumber_idx" ON "Order"("invoiceNumber");
CREATE INDEX IF NOT EXISTS "Order_trackingCode_idx" ON "Order"("trackingCode");
CREATE INDEX IF NOT EXISTS "Order_isDelayed_idx" ON "Order"("isDelayed");
CREATE INDEX IF NOT EXISTS "Order_lastApiSync_idx" ON "Order"("lastApiSync");
CREATE INDEX IF NOT EXISTS "Order_originalQuotedFreightQuotationId_idx" ON "Order"("originalQuotedFreightQuotationId");
CREATE INDEX IF NOT EXISTS "Order_archived_company_idx" ON "Order"("isArchived", "companyId");

-- Create SyncNotification table if it doesn't exist
CREATE TABLE IF NOT EXISTS "SyncNotification" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "payload" JSONB,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SyncNotification_pkey" PRIMARY KEY ("id")
);

-- Add missing columns to SyncNotification if they don't exist
ALTER TABLE "SyncNotification"
  ADD COLUMN IF NOT EXISTS "readAt" TIMESTAMP(3);

-- Create indexes on SyncNotification table
CREATE INDEX IF NOT EXISTS "SyncNotification_company_created_idx" ON "SyncNotification"("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "SyncNotification_company_category_created_idx" ON "SyncNotification"("companyId", "category", "createdAt");
CREATE INDEX IF NOT EXISTS "SyncNotification_company_read_created_idx" ON "SyncNotification"("companyId", "readAt", "createdAt");

-- Add foreign key constraints if they don't exist
DO $$
DECLARE
  order_carrier_udt TEXT;
  carrier_id_udt TEXT;
BEGIN
  IF to_regclass('public."Order"') IS NOT NULL
    AND to_regclass('public."Carrier"') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'Order_carrierId_fkey'
    ) THEN
    SELECT udt_name
    INTO order_carrier_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Order'
      AND column_name = 'carrierId';

    SELECT udt_name
    INTO carrier_id_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Carrier'
      AND column_name = 'id';

    IF COALESCE(order_carrier_udt, '') = COALESCE(carrier_id_udt, '') THEN
      BEGIN
        ALTER TABLE "Order"
          ADD CONSTRAINT "Order_carrierId_fkey"
          FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id")
          ON DELETE SET NULL ON UPDATE CASCADE;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE NOTICE 'Nao foi possivel criar Order_carrierId_fkey: %', SQLERRM;
      END;
    ELSE
      RAISE NOTICE 'Pulando Order_carrierId_fkey por incompatibilidade de tipo: Order.carrierId=% / Carrier.id=%', order_carrier_udt, carrier_id_udt;
    END IF;
  END IF;
END $$;

DO $$
DECLARE
  order_createdby_udt TEXT;
  user_id_udt TEXT;
BEGIN
  IF to_regclass('public."Order"') IS NOT NULL
    AND to_regclass('public."User"') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'Order_createdById_fkey'
    ) THEN
    SELECT udt_name
    INTO order_createdby_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Order'
      AND column_name = 'createdById';

    SELECT udt_name
    INTO user_id_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'User'
      AND column_name = 'id';

    IF COALESCE(order_createdby_udt, '') = COALESCE(user_id_udt, '') THEN
      BEGIN
        ALTER TABLE "Order"
          ADD CONSTRAINT "Order_createdById_fkey"
          FOREIGN KEY ("createdById") REFERENCES "User"("id")
          ON DELETE SET NULL ON UPDATE CASCADE;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE NOTICE 'Nao foi possivel criar Order_createdById_fkey: %', SQLERRM;
      END;
    ELSE
      RAISE NOTICE 'Pulando Order_createdById_fkey por incompatibilidade de tipo: Order.createdById=% / User.id=%', order_createdby_udt, user_id_udt;
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

DO $$
DECLARE
  sync_company_udt TEXT;
  company_id_udt TEXT;
BEGIN
  IF to_regclass('public."SyncNotification"') IS NOT NULL
    AND to_regclass('public."Company"') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'SyncNotification_companyId_fkey'
    ) THEN
    SELECT udt_name
    INTO sync_company_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'SyncNotification'
      AND column_name = 'companyId';

    SELECT udt_name
    INTO company_id_udt
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Company'
      AND column_name = 'id';

    IF COALESCE(sync_company_udt, '') = COALESCE(company_id_udt, '') THEN
      BEGIN
        DELETE FROM "SyncNotification" s
        WHERE s."companyId" IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM "Company" c
            WHERE c."id"::TEXT = s."companyId"::TEXT
          );

        ALTER TABLE "SyncNotification"
          ADD CONSTRAINT "SyncNotification_companyId_fkey"
          FOREIGN KEY ("companyId") REFERENCES "Company"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE NOTICE 'Nao foi possivel criar SyncNotification_companyId_fkey: %', SQLERRM;
      END;
    ELSE
      RAISE NOTICE 'Pulando SyncNotification_companyId_fkey por incompatibilidade de tipo: SyncNotification.companyId=% / Company.id=%', sync_company_udt, company_id_udt;
    END IF;
  END IF;
END $$;

COMMIT;
