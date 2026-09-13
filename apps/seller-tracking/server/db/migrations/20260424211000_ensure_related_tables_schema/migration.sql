-- Migration: 20260424211000_ensure_related_tables_schema
-- Module: avantracking
-- Purpose: Ensure related tables (TrackingEvent, MonitoredOrder, TrayCheckoutQuote) exist

BEGIN;

-- Create TrackingEvent table if it doesn't exist
CREATE TABLE IF NOT EXISTS "TrackingEvent" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "eventDate" TIMESTAMP(3) NOT NULL,
  "eventDetails" JSONB,
  "carrier" TEXT,
  "city" TEXT,
  "state" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TrackingEvent_pkey" PRIMARY KEY ("id")
);

-- Add missing columns to TrackingEvent if they don't exist
ALTER TABLE "TrackingEvent"
  ADD COLUMN IF NOT EXISTS "orderId" TEXT,
  ADD COLUMN IF NOT EXISTS "eventType" TEXT,
  ADD COLUMN IF NOT EXISTS "eventDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "eventDetails" JSONB,
  ADD COLUMN IF NOT EXISTS "carrier" TEXT,
  ADD COLUMN IF NOT EXISTS "city" TEXT,
  ADD COLUMN IF NOT EXISTS "state" TEXT,
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Create indexes on TrackingEvent table
CREATE INDEX IF NOT EXISTS "TrackingEvent_orderId_idx" ON "TrackingEvent"("orderId");
CREATE INDEX IF NOT EXISTS "TrackingEvent_eventDate_idx" ON "TrackingEvent"("eventDate");

-- Create MonitoredOrder table if it doesn't exist
CREATE TABLE IF NOT EXISTS "MonitoredOrder" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "createdById" TEXT,
  "watchEvents" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MonitoredOrder_pkey" PRIMARY KEY ("id")
);

-- Add missing columns to MonitoredOrder if they don't exist
ALTER TABLE "MonitoredOrder"
  ADD COLUMN IF NOT EXISTS "companyId" TEXT,
  ADD COLUMN IF NOT EXISTS "orderId" TEXT,
  ADD COLUMN IF NOT EXISTS "createdById" TEXT,
  ADD COLUMN IF NOT EXISTS "watchEvents" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Create unique constraint on MonitoredOrder
DO $$
BEGIN
  IF to_regclass('public."MonitoredOrder"') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'MonitoredOrder_companyId_orderId_key'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'MonitoredOrder_companyId_orderId_key'
    ) THEN
    BEGIN
      ALTER TABLE "MonitoredOrder"
        ADD CONSTRAINT "MonitoredOrder_companyId_orderId_key"
        UNIQUE ("companyId", "orderId");
    EXCEPTION
      WHEN duplicate_object THEN
        RAISE NOTICE 'MonitoredOrder_companyId_orderId_key ja existe; seguindo.';
      WHEN OTHERS THEN
        RAISE NOTICE 'Nao foi possivel criar MonitoredOrder_companyId_orderId_key: %', SQLERRM;
    END;
  END IF;
END $$;

-- Create indexes on MonitoredOrder table
CREATE INDEX IF NOT EXISTS "MonitoredOrder_company_created_idx" ON "MonitoredOrder"("companyId", "createdAt");

-- Create TrayCheckoutQuote table if it doesn't exist
CREATE TABLE IF NOT EXISTS "TrayCheckoutQuote" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "quotationId" TEXT NOT NULL,
  "quoteData" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  CONSTRAINT "TrayCheckoutQuote_pkey" PRIMARY KEY ("id")
);

-- Add missing columns to TrayCheckoutQuote if they don't exist
ALTER TABLE "TrayCheckoutQuote"
  ADD COLUMN IF NOT EXISTS "companyId" TEXT,
  ADD COLUMN IF NOT EXISTS "quotationId" TEXT,
  ADD COLUMN IF NOT EXISTS "quoteData" JSONB,
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);

-- Create indexes on TrayCheckoutQuote table
CREATE INDEX IF NOT EXISTS "TrayCheckoutQuote_companyId_idx" ON "TrayCheckoutQuote"("companyId");
CREATE INDEX IF NOT EXISTS "TrayCheckoutQuote_quotationId_idx" ON "TrayCheckoutQuote"("quotationId");
CREATE INDEX IF NOT EXISTS "TrayCheckoutQuote_expiresAt_idx" ON "TrayCheckoutQuote"("expiresAt");

-- Ensure orderId column type is TEXT in TrackingEvent and remove orphaned records
DO $$
DECLARE
  orderId_type TEXT;
BEGIN
  IF to_regclass('public."TrackingEvent"') IS NOT NULL THEN
    -- Check current column type
    SELECT udt_name INTO orderId_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'TrackingEvent'
      AND column_name = 'orderId';
    
    -- If column exists, try to clean up orphaned records
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'TrackingEvent'
        AND column_name = 'orderId'
    ) THEN
      BEGIN
        -- Delete TrackingEvent records with NULL or non-existent orderId
        -- Use type casting to ensure compatibility
        DELETE FROM "TrackingEvent"
        WHERE "orderId" IS NULL
          OR "orderId"::TEXT NOT IN (SELECT "id"::TEXT FROM "Order");
      EXCEPTION
        WHEN OTHERS THEN
          -- If the comparison fails, try a simpler approach
          DELETE FROM "TrackingEvent" WHERE "orderId" IS NULL;
      END;
    END IF;
  END IF;
END $$;

-- Add foreign key constraints if they don't exist
DO $$
BEGIN
  IF to_regclass('public."TrackingEvent"') IS NOT NULL
    AND to_regclass('public."Order"') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'TrackingEvent_orderId_fkey'
    ) THEN
    BEGIN
      ALTER TABLE "TrackingEvent"
        ADD CONSTRAINT "TrackingEvent_orderId_fkey"
        FOREIGN KEY ("orderId") REFERENCES "Order"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Could not add TrackingEvent_orderId_fkey constraint: %', SQLERRM;
    END;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public."MonitoredOrder"') IS NOT NULL
    AND to_regclass('public."Company"') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'MonitoredOrder_companyId_fkey'
    ) THEN
    BEGIN
      -- Clean up orphaned records first
      DELETE FROM "MonitoredOrder" m
      WHERE m."companyId" IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM "Company" c
          WHERE c."id"::TEXT = m."companyId"::TEXT
        );
      
      ALTER TABLE "MonitoredOrder"
        ADD CONSTRAINT "MonitoredOrder_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Could not add MonitoredOrder_companyId_fkey constraint: %', SQLERRM;
    END;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public."MonitoredOrder"') IS NOT NULL
    AND to_regclass('public."Order"') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'MonitoredOrder_orderId_fkey'
    ) THEN
    BEGIN
      -- Clean up orphaned records first
      DELETE FROM "MonitoredOrder" m
      WHERE m."orderId" IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM "Order" o
          WHERE o."id"::TEXT = m."orderId"::TEXT
        );
      
      ALTER TABLE "MonitoredOrder"
        ADD CONSTRAINT "MonitoredOrder_orderId_fkey"
        FOREIGN KEY ("orderId") REFERENCES "Order"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Could not add MonitoredOrder_orderId_fkey constraint: %', SQLERRM;
    END;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public."MonitoredOrder"') IS NOT NULL
    AND to_regclass('public."User"') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'MonitoredOrder_createdById_fkey'
    ) THEN
    BEGIN
      ALTER TABLE "MonitoredOrder"
        ADD CONSTRAINT "MonitoredOrder_createdById_fkey"
        FOREIGN KEY ("createdById") REFERENCES "User"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Could not add MonitoredOrder_createdById_fkey constraint: %', SQLERRM;
    END;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public."TrayCheckoutQuote"') IS NOT NULL
    AND to_regclass('public."Company"') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'TrayCheckoutQuote_companyId_fkey'
    ) THEN
    BEGIN
      -- Clean up orphaned records first
      DELETE FROM "TrayCheckoutQuote" q
      WHERE q."companyId" IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM "Company" c
          WHERE c."id"::TEXT = q."companyId"::TEXT
        );
      
      ALTER TABLE "TrayCheckoutQuote"
        ADD CONSTRAINT "TrayCheckoutQuote_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Could not add TrayCheckoutQuote_companyId_fkey constraint: %', SQLERRM;
    END;
  END IF;
END $$;

COMMIT;
