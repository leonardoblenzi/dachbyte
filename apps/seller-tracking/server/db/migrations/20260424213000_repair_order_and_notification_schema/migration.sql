-- Migration: 20260424213000_repair_order_and_notification_schema
-- Module: avantracking
-- Purpose: Repair Order.orderNumber and SyncNotification in legacy schemas

BEGIN;

DO $$
BEGIN
  IF to_regclass('public."Order"') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE "Order"
    ADD COLUMN IF NOT EXISTS "orderNumber" TEXT;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Order'
      AND column_name = 'orderNumber'
      AND udt_name <> 'text'
  ) THEN
    BEGIN
      ALTER TABLE "Order"
        ALTER COLUMN "orderNumber" TYPE TEXT USING "orderNumber"::text;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Nao foi possivel converter Order.orderNumber para TEXT: %', SQLERRM;
    END;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Order'
      AND column_name = 'order_number'
  ) THEN
    EXECUTE '
      UPDATE "Order"
      SET "orderNumber" = COALESCE(
        NULLIF(BTRIM("orderNumber"), ''''),
        NULLIF(BTRIM("order_number"::text), ''''),
        "id"::text
      )
      WHERE "orderNumber" IS NULL OR BTRIM("orderNumber") = ''''
    ';
  ELSE
    UPDATE "Order"
    SET "orderNumber" = COALESCE(
      NULLIF(BTRIM("orderNumber"), ''),
      "id"::text
    )
    WHERE "orderNumber" IS NULL OR BTRIM("orderNumber") = '';
  END IF;

  BEGIN
    ALTER TABLE "Order" ALTER COLUMN "orderNumber" SET NOT NULL;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'Nao foi possivel definir NOT NULL em Order.orderNumber: %', SQLERRM;
  END;

  CREATE INDEX IF NOT EXISTS "Order_orderNumber_idx" ON "Order" ("orderNumber");
END $$;

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

ALTER TABLE "SyncNotification"
  ADD COLUMN IF NOT EXISTS "id" TEXT,
  ADD COLUMN IF NOT EXISTS "companyId" TEXT,
  ADD COLUMN IF NOT EXISTS "category" TEXT,
  ADD COLUMN IF NOT EXISTS "type" TEXT,
  ADD COLUMN IF NOT EXISTS "title" TEXT,
  ADD COLUMN IF NOT EXISTS "message" TEXT,
  ADD COLUMN IF NOT EXISTS "payload" JSONB,
  ADD COLUMN IF NOT EXISTS "readAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

DO $$
DECLARE
  rec RECORD;
BEGIN
  IF to_regclass('public."SyncNotification"') IS NULL THEN
    RETURN;
  END IF;

  FOR rec IN
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'SyncNotification'
      AND column_name IN ('id', 'companyId', 'category', 'type', 'title', 'message')
      AND udt_name <> 'text'
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE "SyncNotification" ALTER COLUMN %I TYPE TEXT USING %I::text',
        rec.column_name,
        rec.column_name
      );
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Nao foi possivel converter SyncNotification.% para TEXT: %', rec.column_name, SQLERRM;
    END;
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'SyncNotification'
      AND column_name = 'id'
  ) THEN
    UPDATE "SyncNotification"
    SET "id" = COALESCE(
      NULLIF(BTRIM(COALESCE("id"::text, '')), ''),
      md5(random()::text || clock_timestamp()::text)
    )
    WHERE "id" IS NULL OR BTRIM(COALESCE("id"::text, '')) = '';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'SyncNotification'
      AND column_name = 'companyId'
  ) THEN
    DELETE FROM "SyncNotification"
    WHERE "companyId" IS NULL OR BTRIM(COALESCE("companyId"::text, '')) = '';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public."SyncNotification"') IS NULL THEN
    RETURN;
  END IF;

  UPDATE "SyncNotification"
  SET
    "category" = COALESCE(NULLIF(BTRIM(COALESCE("category"::text, '')), ''), 'GENERAL'),
    "type" = COALESCE(NULLIF(BTRIM(COALESCE("type"::text, '')), ''), 'INFO'),
    "title" = COALESCE(NULLIF(BTRIM(COALESCE("title"::text, '')), ''), 'Notificacao'),
    "message" = COALESCE(NULLIF(BTRIM(COALESCE("message"::text, '')), ''), 'Atualizacao do sistema'),
    "createdAt" = COALESCE("createdAt", NOW());

  BEGIN
    ALTER TABLE "SyncNotification" ALTER COLUMN "id" SET NOT NULL;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'Nao foi possivel definir NOT NULL em SyncNotification.id: %', SQLERRM;
  END;
  BEGIN
    ALTER TABLE "SyncNotification" ALTER COLUMN "companyId" SET NOT NULL;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'Nao foi possivel definir NOT NULL em SyncNotification.companyId: %', SQLERRM;
  END;
  BEGIN
    ALTER TABLE "SyncNotification" ALTER COLUMN "category" SET NOT NULL;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'Nao foi possivel definir NOT NULL em SyncNotification.category: %', SQLERRM;
  END;
  BEGIN
    ALTER TABLE "SyncNotification" ALTER COLUMN "type" SET NOT NULL;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'Nao foi possivel definir NOT NULL em SyncNotification.type: %', SQLERRM;
  END;
  BEGIN
    ALTER TABLE "SyncNotification" ALTER COLUMN "title" SET NOT NULL;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'Nao foi possivel definir NOT NULL em SyncNotification.title: %', SQLERRM;
  END;
  BEGIN
    ALTER TABLE "SyncNotification" ALTER COLUMN "message" SET NOT NULL;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'Nao foi possivel definir NOT NULL em SyncNotification.message: %', SQLERRM;
  END;
  BEGIN
    ALTER TABLE "SyncNotification" ALTER COLUMN "createdAt" SET NOT NULL;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'Nao foi possivel definir NOT NULL em SyncNotification.createdAt: %', SQLERRM;
  END;
END $$;

CREATE INDEX IF NOT EXISTS "SyncNotification_company_created_idx"
  ON "SyncNotification" ("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "SyncNotification_company_category_created_idx"
  ON "SyncNotification" ("companyId", "category", "createdAt");
CREATE INDEX IF NOT EXISTS "SyncNotification_company_read_created_idx"
  ON "SyncNotification" ("companyId", "readAt", "createdAt");

DO $$
DECLARE
  sync_company_udt TEXT;
  company_id_udt TEXT;
BEGIN
  IF to_regclass('public."SyncNotification"') IS NULL
    OR to_regclass('public."Company"') IS NULL
    OR EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'SyncNotification_companyId_fkey'
    ) THEN
    RETURN;
  END IF;

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
END $$;

COMMIT;
