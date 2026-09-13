-- CreateEnum
CREATE TYPE "AdsChannel" AS ENUM ('CPC', 'GMS');

-- CreateEnum
CREATE TYPE "AdsMatchConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "itemsSubtotalCents" INTEGER,
ADD COLUMN     "shippingCents" INTEGER;

-- CreateTable
CREATE TABLE "AdsHourlyMetric" (
    "id" SERIAL NOT NULL,
    "shopId" INTEGER NOT NULL,
    "channel" "AdsChannel" NOT NULL DEFAULT 'CPC',
    "dateHour" TIMESTAMP(3) NOT NULL,
    "spendCents" INTEGER NOT NULL DEFAULT 0,
    "gmvRawCents" INTEGER,
    "gmvDeltaCents" INTEGER,
    "gmvDirectRawCents" INTEGER,
    "gmvDirectDeltaCents" INTEGER,
    "gmvBroadRawCents" INTEGER,
    "gmvBroadDeltaCents" INTEGER,
    "raw" JSONB,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdsHourlyMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderAdsAttribution" (
    "id" SERIAL NOT NULL,
    "shopId" INTEGER NOT NULL,
    "orderId" INTEGER NOT NULL,
    "channel" "AdsChannel" NOT NULL DEFAULT 'CPC',
    "matchedHour" TIMESTAMP(3) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "confidence" "AdsMatchConfidence" NOT NULL DEFAULT 'MEDIUM',
    "orderCreateTime" TIMESTAMP(3),
    "matchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rule" TEXT,

    CONSTRAINT "OrderAdsAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsHourlyMetric_shopId_dateHour_idx" ON "AdsHourlyMetric"("shopId", "dateHour");

-- CreateIndex
CREATE UNIQUE INDEX "AdsHourlyMetric_shopId_channel_dateHour_key" ON "AdsHourlyMetric"("shopId", "channel", "dateHour");

-- CreateIndex
CREATE UNIQUE INDEX "OrderAdsAttribution_orderId_key" ON "OrderAdsAttribution"("orderId");

-- CreateIndex
CREATE INDEX "OrderAdsAttribution_shopId_matchedHour_idx" ON "OrderAdsAttribution"("shopId", "matchedHour");

-- CreateIndex
CREATE INDEX "OrderAdsAttribution_shopId_confidence_idx" ON "OrderAdsAttribution"("shopId", "confidence");

-- AddForeignKey
ALTER TABLE "AdsHourlyMetric" ADD CONSTRAINT "AdsHourlyMetric_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAdsAttribution" ADD CONSTRAINT "OrderAdsAttribution_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAdsAttribution" ADD CONSTRAINT "OrderAdsAttribution_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
