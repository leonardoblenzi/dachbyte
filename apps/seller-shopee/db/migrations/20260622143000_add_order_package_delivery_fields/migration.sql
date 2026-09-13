-- Migration: 20260622143000_add_order_package_delivery_fields
-- Module: shopee
-- Purpose: Persist Shopee package shipment and delivery forecast details from get_package_detail

BEGIN;

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "packageNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "packageFulfillmentStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "packageLogisticsChannelId" BIGINT,
  ADD COLUMN IF NOT EXISTS "packageTrackingNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "packageShipByDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "packagePickupDoneTime" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "estimatedDeliveryTime" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "estimatedDeliveryStartTime" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "estimatedDeliveryEndTime" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "preparationEndTime" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "driverEtaStartTime" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "driverEtaEndTime" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "packageDetailRaw" JSONB;

CREATE INDEX IF NOT EXISTS "Order_shopId_packageShipByDate_idx"
  ON "Order"("shopId", "packageShipByDate");

CREATE INDEX IF NOT EXISTS "Order_shopId_packagePickupDoneTime_idx"
  ON "Order"("shopId", "packagePickupDoneTime");

CREATE INDEX IF NOT EXISTS "Order_shopId_estimatedDeliveryTime_idx"
  ON "Order"("shopId", "estimatedDeliveryTime");

COMMIT;
