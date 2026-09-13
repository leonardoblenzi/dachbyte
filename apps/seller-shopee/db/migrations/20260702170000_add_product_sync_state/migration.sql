CREATE TABLE IF NOT EXISTS "ProductSyncState" (
  "shopId" INTEGER NOT NULL,
  "runCount" INTEGER NOT NULL DEFAULT 0,
  "lastSyncedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductSyncState_pkey" PRIMARY KEY ("shopId")
);

DO $$
BEGIN
  IF to_regclass('public."Shop"') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'ProductSyncState_shopId_fkey'
    ) THEN
    ALTER TABLE "ProductSyncState"
      ADD CONSTRAINT "ProductSyncState_shopId_fkey"
      FOREIGN KEY ("shopId") REFERENCES "Shop"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END $$;
