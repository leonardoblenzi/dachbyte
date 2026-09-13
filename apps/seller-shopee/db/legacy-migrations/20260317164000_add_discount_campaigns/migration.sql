-- CreateTable "DiscountCampaign"
CREATE TABLE IF NOT EXISTS "DiscountCampaign" (
    "id" SERIAL NOT NULL,
    "shopId" INTEGER NOT NULL,
    "shopeeDiscountId" BIGINT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "syncedToShopee" BOOLEAN NOT NULL DEFAULT false,
    "shoppeeUpdateTime" TIMESTAMP(3),
    "description" TEXT,
    "tags" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscountCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable "DiscountItem"
CREATE TABLE IF NOT EXISTS "DiscountItem" (
    "id" SERIAL NOT NULL,
    "campaignId" INTEGER NOT NULL,
    "itemId" BIGINT NOT NULL,
    "promotionPrice" INTEGER,
    "modelId" BIGINT,
    "modelPromotionPrice" INTEGER,
    "promotionStock" INTEGER,
    "modelPromotionStock" INTEGER,
    "purchaseLimit" INTEGER NOT NULL DEFAULT 0,
    "productId" INTEGER,
    "syncedToShopee" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscountItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DiscountCampaign_shopeeDiscountId_key" ON "DiscountCampaign"("shopeeDiscountId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DiscountCampaign_shopId_status_idx" ON "DiscountCampaign"("shopId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DiscountCampaign_shopId_startTime_endTime_idx" ON "DiscountCampaign"("shopId", "startTime", "endTime");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DiscountItem_campaignId_itemId_modelId_key" ON "DiscountItem"("campaignId", "itemId", "modelId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DiscountItem_campaignId_idx" ON "DiscountItem"("campaignId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DiscountItem_itemId_idx" ON "DiscountItem"("itemId");

-- AddForeignKey
ALTER TABLE IF EXISTS "DiscountCampaign" ADD CONSTRAINT "DiscountCampaign_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE IF EXISTS "DiscountItem" ADD CONSTRAINT "DiscountItem_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "DiscountCampaign"("id") ON DELETE Cascade ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE IF EXISTS "DiscountItem" ADD CONSTRAINT "DiscountItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
