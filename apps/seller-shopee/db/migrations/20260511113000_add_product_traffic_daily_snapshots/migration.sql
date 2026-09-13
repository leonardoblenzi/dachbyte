-- Migration: 20260511113000_add_product_traffic_daily_snapshots
-- Module: shopee
-- Purpose: Persist traffic snapshots per item/day to reduce live API calls in Sales Control

BEGIN;

CREATE TABLE IF NOT EXISTS "ProductTrafficDaily" (
  "id" SERIAL NOT NULL,
  "shopId" INTEGER NOT NULL,
  "itemId" BIGINT NOT NULL,
  "trafficDate" DATE NOT NULL,
  "impressionsCumulative" BIGINT NOT NULL DEFAULT 0,
  "visitsCumulative" BIGINT NOT NULL DEFAULT 0,
  "impressionsDelta" BIGINT NOT NULL DEFAULT 0,
  "visitsDelta" BIGINT NOT NULL DEFAULT 0,
  "source" TEXT NOT NULL DEFAULT 'item_extra_info',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductTrafficDaily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProductTrafficDaily_shopId_itemId_trafficDate_key"
  ON "ProductTrafficDaily"("shopId", "itemId", "trafficDate");

CREATE INDEX IF NOT EXISTS "ProductTrafficDaily_shopId_trafficDate_idx"
  ON "ProductTrafficDaily"("shopId", "trafficDate");

CREATE INDEX IF NOT EXISTS "ProductTrafficDaily_shopId_itemId_trafficDate_idx"
  ON "ProductTrafficDaily"("shopId", "itemId", "trafficDate" DESC);

DO $$
BEGIN
  IF to_regclass('public."Shop"') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname = 'ProductTrafficDaily_shopId_fkey'
     ) THEN
    ALTER TABLE "ProductTrafficDaily"
      ADD CONSTRAINT "ProductTrafficDaily_shopId_fkey"
      FOREIGN KEY ("shopId") REFERENCES "Shop"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
