ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "shippingModeCache" TEXT,
  ADD COLUMN IF NOT EXISTS "spxEnabledCache" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "spxLogisticsEligibleCache" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "spxPhysicalEligibleCache" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "spxEligibleCache" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "spxEligibilityReasonsCache" JSONB,
  ADD COLUMN IF NOT EXISTS "spxSnapshotAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Product_shopId_spxEnabledCache_idx"
  ON "Product"("shopId", "spxEnabledCache");

CREATE INDEX IF NOT EXISTS "Product_shopId_spxEligibleCache_idx"
  ON "Product"("shopId", "spxEligibleCache");
