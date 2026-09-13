BEGIN;

CREATE TABLE IF NOT EXISTS "PricingV6Setting" (
  "shopId" INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  "applicationEnabled" BOOLEAN NOT NULL DEFAULT false,
  "createdByUserId" INTEGER NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PricingV6Setting_pkey" PRIMARY KEY ("shopId")
);

CREATE TABLE IF NOT EXISTS "PricingV6Snapshot" (
  id UUID NOT NULL,
  "shopId" INTEGER NOT NULL,
  "settingsVersion" INTEGER NOT NULL,
  selection JSONB NOT NULL,
  result JSONB NOT NULL,
  "createdByUserId" INTEGER NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PricingV6Snapshot_pkey" PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS "PricingV6Job" (
  id UUID NOT NULL,
  "shopId" INTEGER NOT NULL,
  "snapshotId" UUID NOT NULL,
  state TEXT NOT NULL DEFAULT 'awaiting_confirmation',
  "conflictPolicy" TEXT NOT NULL DEFAULT 'skip',
  "idempotencyKey" TEXT NOT NULL,
  "requestedByUserId" INTEGER NULL,
  progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  "errorMessage" TEXT NULL,
  "cancelRequestedAt" TIMESTAMP(3) NULL,
  "queuedAt" TIMESTAMP(3) NULL,
  "startedAt" TIMESTAMP(3) NULL,
  "finishedAt" TIMESTAMP(3) NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PricingV6Job_pkey" PRIMARY KEY (id),
  CONSTRAINT "PricingV6Job_idempotencyKey_key" UNIQUE ("idempotencyKey")
);

CREATE TABLE IF NOT EXISTS "PricingV6JobItem" (
  id BIGSERIAL NOT NULL,
  "jobId" UUID NOT NULL,
  "productId" INTEGER NULL,
  "itemId" BIGINT NOT NULL,
  "modelId" BIGINT NULL,
  title TEXT NULL,
  sku TEXT NULL,
  "previousPriceCents" INTEGER NULL,
  "recommendedPriceCents" INTEGER NULL,
  "fullPriceCents" INTEGER NULL,
  "marginRate" NUMERIC(12, 8) NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  "shopeeDiscountId" BIGINT NULL,
  "responsePayload" JSONB NULL,
  "errorMessage" TEXT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PricingV6JobItem_pkey" PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS "PricingV6Audit" (
  id BIGSERIAL NOT NULL,
  "shopId" INTEGER NOT NULL,
  "jobId" UUID NULL,
  "productId" INTEGER NULL,
  "itemId" BIGINT NULL,
  "modelId" BIGINT NULL,
  action TEXT NOT NULL,
  "previousPriceCents" INTEGER NULL,
  "nextPriceCents" INTEGER NULL,
  "marginRate" NUMERIC(12, 8) NULL,
  "actorUserId" INTEGER NULL,
  payload JSONB NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PricingV6Audit_pkey" PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS "PricingV6Snapshot_shopId_createdAt_idx"
  ON "PricingV6Snapshot" ("shopId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "PricingV6Job_shopId_createdAt_idx"
  ON "PricingV6Job" ("shopId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "PricingV6Job_shopId_state_idx"
  ON "PricingV6Job" ("shopId", state);
CREATE INDEX IF NOT EXISTS "PricingV6JobItem_jobId_state_idx"
  ON "PricingV6JobItem" ("jobId", state);
CREATE INDEX IF NOT EXISTS "PricingV6Audit_shopId_createdAt_idx"
  ON "PricingV6Audit" ("shopId", "createdAt" DESC);

DO $$
BEGIN
  IF to_regclass('public."Shop"') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PricingV6Setting_shopId_fkey') THEN
      ALTER TABLE "PricingV6Setting" ADD CONSTRAINT "PricingV6Setting_shopId_fkey"
        FOREIGN KEY ("shopId") REFERENCES "Shop"(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PricingV6Snapshot_shopId_fkey') THEN
      ALTER TABLE "PricingV6Snapshot" ADD CONSTRAINT "PricingV6Snapshot_shopId_fkey"
        FOREIGN KEY ("shopId") REFERENCES "Shop"(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PricingV6Job_shopId_fkey') THEN
      ALTER TABLE "PricingV6Job" ADD CONSTRAINT "PricingV6Job_shopId_fkey"
        FOREIGN KEY ("shopId") REFERENCES "Shop"(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PricingV6Audit_shopId_fkey') THEN
      ALTER TABLE "PricingV6Audit" ADD CONSTRAINT "PricingV6Audit_shopId_fkey"
        FOREIGN KEY ("shopId") REFERENCES "Shop"(id) ON DELETE CASCADE;
    END IF;
  END IF;
END $$;

COMMIT;
