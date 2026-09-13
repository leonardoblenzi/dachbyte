CREATE TABLE IF NOT EXISTS "ListingCloneDraft" (
    "id" SERIAL NOT NULL,
    "shopId" INTEGER NOT NULL,
    "userId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "sourcePlatform" TEXT,
    "sourceUrl" TEXT,
    "sourceItemId" BIGINT,
    "title" TEXT,
    "draftData" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "publishedItemId" BIGINT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingCloneDraft_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ListingCloneDraft_shopId_status_updatedAt_idx"
    ON "ListingCloneDraft"("shopId", status, "updatedAt" DESC);

CREATE INDEX IF NOT EXISTS "ListingCloneDraft_shopId_sourceItemId_idx"
    ON "ListingCloneDraft"("shopId", "sourceItemId");

ALTER TABLE IF EXISTS "ListingCloneDraft"
    ADD CONSTRAINT "ListingCloneDraft_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE IF EXISTS "ListingCloneDraft"
    ADD CONSTRAINT "ListingCloneDraft_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ProductBoostBatch" (
    "id" SERIAL NOT NULL,
    "shopId" INTEGER NOT NULL,
    "userId" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "requestedItemIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "requestId" TEXT,
    "warning" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductBoostBatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ProductBoostBatch_shopId_createdAt_idx"
    ON "ProductBoostBatch"("shopId", "createdAt" DESC);

ALTER TABLE IF EXISTS "ProductBoostBatch"
    ADD CONSTRAINT "ProductBoostBatch_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE IF EXISTS "ProductBoostBatch"
    ADD CONSTRAINT "ProductBoostBatch_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ProductBoostBatchItem" (
    "id" SERIAL NOT NULL,
    "batchId" INTEGER NOT NULL,
    "shopId" INTEGER NOT NULL,
    "itemId" BIGINT NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "failedReason" TEXT,
    "coolDownSecondSnapshot" INTEGER,
    "boostStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "boostWindowEndsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductBoostBatchItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProductBoostBatchItem_batchId_itemId_key"
    ON "ProductBoostBatchItem"("batchId", "itemId");

CREATE INDEX IF NOT EXISTS "ProductBoostBatchItem_shopId_itemId_boostStartedAt_idx"
    ON "ProductBoostBatchItem"("shopId", "itemId", "boostStartedAt" DESC);

CREATE INDEX IF NOT EXISTS "ProductBoostBatchItem_shopId_success_boostStartedAt_idx"
    ON "ProductBoostBatchItem"("shopId", success, "boostStartedAt" DESC);

ALTER TABLE IF EXISTS "ProductBoostBatchItem"
    ADD CONSTRAINT "ProductBoostBatchItem_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "ProductBoostBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE IF EXISTS "ProductBoostBatchItem"
    ADD CONSTRAINT "ProductBoostBatchItem_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
