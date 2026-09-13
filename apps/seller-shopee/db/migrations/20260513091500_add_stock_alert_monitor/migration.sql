-- Migration: 20260513091500_add_stock_alert_monitor
-- Module: shopee
-- Purpose: Persist monitored items and replenishment workflow for stock alert intelligence

BEGIN;

CREATE TABLE IF NOT EXISTS "StockAlertMonitor" (
  "id" SERIAL NOT NULL,
  "shopId" INTEGER NOT NULL,
  "itemId" BIGINT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'monitoring',
  "expectedArrivalDate" DATE NULL,
  "purchaseMarkedAt" TIMESTAMP(3) NULL,
  "lastKnownStock" INTEGER NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockAlertMonitor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StockAlertMonitor_shopId_itemId_key"
  ON "StockAlertMonitor"("shopId", "itemId");

CREATE INDEX IF NOT EXISTS "StockAlertMonitor_shopId_isActive_idx"
  ON "StockAlertMonitor"("shopId", "isActive");

CREATE INDEX IF NOT EXISTS "StockAlertMonitor_shopId_status_expectedArrival_idx"
  ON "StockAlertMonitor"("shopId", status, "expectedArrivalDate");

DO $$
BEGIN
  IF to_regclass('public."Shop"') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname = 'StockAlertMonitor_shopId_fkey'
     ) THEN
    ALTER TABLE "StockAlertMonitor"
      ADD CONSTRAINT "StockAlertMonitor_shopId_fkey"
      FOREIGN KEY ("shopId") REFERENCES "Shop"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;

