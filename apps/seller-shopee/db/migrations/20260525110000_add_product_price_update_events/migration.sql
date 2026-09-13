-- Migration: 20260525110000_add_product_price_update_events
-- Module: shopee
-- Purpose: Persist Shopee item_price_update_push events and promotion lock window

BEGIN;

CREATE TABLE IF NOT EXISTS "ProductPriceUpdateEvent" (
  "id" SERIAL NOT NULL,
  "eventKey" TEXT NOT NULL,
  "shopId" INTEGER NOT NULL,
  "itemId" BIGINT NOT NULL,
  "modelId" BIGINT NULL,
  "updateField" TEXT NOT NULL,
  "oldValue" NUMERIC(18, 6) NULL,
  "newValue" NUMERIC(18, 6) NULL,
  "updateTime" TIMESTAMP(3) NOT NULL,
  "pushTimestamp" TIMESTAMP(3) NULL,
  "isBlockedForPromotion" BOOLEAN NOT NULL DEFAULT false,
  "lockUntil" TIMESTAMP(3) NULL,
  payload JSONB NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductPriceUpdateEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProductPriceUpdateEvent_eventKey_key"
  ON "ProductPriceUpdateEvent"("eventKey");

CREATE INDEX IF NOT EXISTS "ProductPriceUpdateEvent_shopId_updateTime_idx"
  ON "ProductPriceUpdateEvent"("shopId", "updateTime" DESC);

CREATE INDEX IF NOT EXISTS "ProductPriceUpdateEvent_shopId_itemId_lockUntil_idx"
  ON "ProductPriceUpdateEvent"("shopId", "itemId", "lockUntil" DESC);

CREATE INDEX IF NOT EXISTS "ProductPriceUpdateEvent_shopId_blocked_lockUntil_idx"
  ON "ProductPriceUpdateEvent"("shopId", "isBlockedForPromotion", "lockUntil" DESC);

DO $$
BEGIN
  IF to_regclass('public."Shop"') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname = 'ProductPriceUpdateEvent_shopId_fkey'
     ) THEN
    DELETE FROM "ProductPriceUpdateEvent" e
    WHERE NOT EXISTS (
      SELECT 1
      FROM "Shop" s
      WHERE s."id" = e."shopId"
    );

    ALTER TABLE "ProductPriceUpdateEvent"
      ADD CONSTRAINT "ProductPriceUpdateEvent_shopId_fkey"
      FOREIGN KEY ("shopId") REFERENCES "Shop"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
