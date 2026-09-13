BEGIN;

CREATE TABLE IF NOT EXISTS "PricingV7CalibrationOrder" (
  id BIGSERIAL PRIMARY KEY,
  "shopId" INTEGER NOT NULL,
  "orderId" INTEGER NULL,
  "orderSn" TEXT NOT NULL,
  "itemId" BIGINT NOT NULL DEFAULT 0,
  "modelId" BIGINT NOT NULL DEFAULT 0,
  sku TEXT NULL,
  "financialState" TEXT NOT NULL,
  "financialQualityScore" NUMERIC(8, 6) NOT NULL DEFAULT 0,
  "promotionalPriceCents" BIGINT NOT NULL DEFAULT 0,
  "sellerCouponCents" BIGINT NOT NULL DEFAULT 0,
  "platformCouponCents" BIGINT NOT NULL DEFAULT 0,
  "coinsCents" BIGINT NOT NULL DEFAULT 0,
  "buyerShippingCents" BIGINT NOT NULL DEFAULT 0,
  "gmvPaidCents" BIGINT NOT NULL DEFAULT 0,
  "commissionCents" BIGINT NOT NULL DEFAULT 0,
  "serviceFeeCents" BIGINT NOT NULL DEFAULT 0,
  "rebateCents" BIGINT NOT NULL DEFAULT 0,
  "adjustmentCents" BIGINT NOT NULL DEFAULT 0,
  "payoutCents" BIGINT NOT NULL DEFAULT 0,
  "cmvCents" BIGINT NOT NULL DEFAULT 0,
  "taxCents" BIGINT NOT NULL DEFAULT 0,
  "financialSource" TEXT NOT NULL DEFAULT 'ORDER_ESCROW',
  "isProvisional" BOOLEAN NOT NULL DEFAULT true,
  "isFinalized" BOOLEAN NOT NULL DEFAULT false,
  "isOutlier" BOOLEAN NOT NULL DEFAULT false,
  "excludedFromCalibration" BOOLEAN NOT NULL DEFAULT false,
  "exclusionReason" TEXT NULL,
  reconciliation JSONB NOT NULL DEFAULT '{}'::jsonb,
  "sourceUpdatedAt" TIMESTAMP(3) NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PricingV7CalibrationOrder_shop_order_item_model_key"
    UNIQUE ("shopId", "orderSn", "itemId", "modelId")
);

CREATE TABLE IF NOT EXISTS "PricingV7CalibrationCohort" (
  id BIGSERIAL PRIMARY KEY,
  "shopId" INTEGER NOT NULL,
  "scopeType" TEXT NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "windowEnd" TIMESTAMP(3) NOT NULL,
  "sampleSize" INTEGER NOT NULL DEFAULT 0,
  "effectiveSampleSize" NUMERIC(12, 4) NOT NULL DEFAULT 0,
  "averageQuality" NUMERIC(8, 6) NOT NULL DEFAULT 0,
  "stabilityScore" NUMERIC(8, 6) NOT NULL DEFAULT 0,
  "gmvFactorP50" NUMERIC(14, 8) NULL,
  "payoutGmvFactorWeighted" NUMERIC(14, 8) NULL,
  "suggestedAlpha" NUMERIC(8, 6) NOT NULL DEFAULT 0,
  "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "engineVersion" TEXT NOT NULL DEFAULT 'V7',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PricingV7CalibrationCohort_shop_scope_key"
    UNIQUE ("shopId", "scopeType", "scopeKey")
);

CREATE INDEX IF NOT EXISTS "PricingV7CalibrationOrder_shop_state_idx"
  ON "PricingV7CalibrationOrder" ("shopId", "financialState", "excludedFromCalibration");
CREATE INDEX IF NOT EXISTS "PricingV7CalibrationOrder_shop_item_idx"
  ON "PricingV7CalibrationOrder" ("shopId", "itemId", "modelId");
CREATE INDEX IF NOT EXISTS "PricingV7CalibrationCohort_shop_scope_idx"
  ON "PricingV7CalibrationCohort" ("shopId", "scopeType", "scopeKey");

DO $$
BEGIN
  IF to_regclass('public."Shop"') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PricingV7CalibrationOrder_shopId_fkey') THEN
    ALTER TABLE "PricingV7CalibrationOrder"
      ADD CONSTRAINT "PricingV7CalibrationOrder_shopId_fkey"
      FOREIGN KEY ("shopId") REFERENCES "Shop"(id) ON DELETE CASCADE;
  END IF;
  IF to_regclass('public."Shop"') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PricingV7CalibrationCohort_shopId_fkey') THEN
    ALTER TABLE "PricingV7CalibrationCohort"
      ADD CONSTRAINT "PricingV7CalibrationCohort_shopId_fkey"
      FOREIGN KEY ("shopId") REFERENCES "Shop"(id) ON DELETE CASCADE;
  END IF;
END $$;

COMMIT;
