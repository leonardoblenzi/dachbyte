ALTER TABLE "PricingV6Snapshot"
  ALTER COLUMN "expiresAt" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "requestKey" TEXT,
  ADD COLUMN IF NOT EXISTS "invalidatedAt" TIMESTAMP(3);

UPDATE "PricingV6Snapshot"
SET "requestKey" = CONCAT('legacy:', id::text)
WHERE "requestKey" IS NULL;

ALTER TABLE "PricingV6Snapshot"
  ALTER COLUMN "requestKey" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "PricingV6Snapshot_reusable_idx"
  ON "PricingV6Snapshot" ("shopId", "settingsVersion", "requestKey", "createdAt" DESC)
  WHERE "invalidatedAt" IS NULL;
