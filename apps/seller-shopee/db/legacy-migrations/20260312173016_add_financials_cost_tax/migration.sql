/*
  Warnings:

  - You are about to drop the column `capturedAt` on the `AdsHourlyMetric` table. All the data in the column will be lost.
  - You are about to drop the column `channel` on the `AdsHourlyMetric` table. All the data in the column will be lost.
  - You are about to drop the column `dateHour` on the `AdsHourlyMetric` table. All the data in the column will be lost.
  - You are about to drop the column `gmvBroadDeltaCents` on the `AdsHourlyMetric` table. All the data in the column will be lost.
  - You are about to drop the column `gmvBroadRawCents` on the `AdsHourlyMetric` table. All the data in the column will be lost.
  - You are about to drop the column `gmvDeltaCents` on the `AdsHourlyMetric` table. All the data in the column will be lost.
  - You are about to drop the column `gmvDirectDeltaCents` on the `AdsHourlyMetric` table. All the data in the column will be lost.
  - You are about to drop the column `gmvDirectRawCents` on the `AdsHourlyMetric` table. All the data in the column will be lost.
  - You are about to drop the column `gmvRawCents` on the `AdsHourlyMetric` table. All the data in the column will be lost.
  - You are about to drop the column `raw` on the `AdsHourlyMetric` table. All the data in the column will be lost.
  - You are about to drop the column `spendCents` on the `AdsHourlyMetric` table. All the data in the column will be lost.
  - You are about to drop the column `detectedAt` on the `OrderAddressChangeAlert` table. All the data in the column will be lost.
  - You are about to drop the column `orderAddressSnapshotId` on the `OrderAddressChangeAlert` table. All the data in the column will be lost.
  - You are about to drop the column `resolvedAt` on the `OrderAddressChangeAlert` table. All the data in the column will be lost.
  - You are about to drop the column `amountCents` on the `OrderAdsAttribution` table. All the data in the column will be lost.
  - You are about to drop the column `channel` on the `OrderAdsAttribution` table. All the data in the column will be lost.
  - You are about to drop the column `confidence` on the `OrderAdsAttribution` table. All the data in the column will be lost.
  - You are about to drop the column `matchedAt` on the `OrderAdsAttribution` table. All the data in the column will be lost.
  - You are about to drop the column `matchedHour` on the `OrderAdsAttribution` table. All the data in the column will be lost.
  - You are about to drop the column `orderCreateTime` on the `OrderAdsAttribution` table. All the data in the column will be lost.
  - You are about to drop the column `rule` on the `OrderAdsAttribution` table. All the data in the column will be lost.
  - You are about to drop the column `gmvCents` on the `OrderItem` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `OrderItem` table. All the data in the column will be lost.
  - You are about to drop the column `priceCents` on the `OrderItem` table. All the data in the column will be lost.
  - You are about to drop the column `sku` on the `OrderItem` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[shopId,date,hour,type,itemId]` on the table `AdsHourlyMetric` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `date` to the `AdsHourlyMetric` table without a default value. This is not possible if the table is not empty.
  - Added the required column `hour` to the `AdsHourlyMetric` table without a default value. This is not possible if the table is not empty.
  - Added the required column `type` to the `AdsHourlyMetric` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `AdsHourlyMetric` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `OrderAddressChangeAlert` table without a default value. This is not possible if the table is not empty.
  - Added the required column `orderSn` to the `OrderAdsAttribution` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `OrderAdsAttribution` table without a default value. This is not possible if the table is not empty.
  - Made the column `itemId` on table `OrderItem` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "OrderAddressChangeAlert" DROP CONSTRAINT "OrderAddressChangeAlert_orderAddressSnapshotId_fkey";

-- DropIndex
DROP INDEX "AdsHourlyMetric_shopId_channel_dateHour_key";

-- DropIndex
DROP INDEX "AdsHourlyMetric_shopId_dateHour_idx";

-- DropIndex
DROP INDEX "OrderAddressChangeAlert_orderId_detectedAt_idx";

-- DropIndex
DROP INDEX "OrderAddressChangeAlert_orderId_newHash_key";

-- DropIndex
DROP INDEX "OrderAddressChangeAlert_resolvedAt_idx";

-- DropIndex
DROP INDEX "OrderAdsAttribution_shopId_confidence_idx";

-- DropIndex
DROP INDEX "OrderAdsAttribution_shopId_matchedHour_idx";

-- DropIndex
DROP INDEX "OrderItem_orderId_itemId_modelId_key";

-- DropIndex
DROP INDEX "OrderItem_shopId_orderId_idx";

-- DropIndex
DROP INDEX "OrderItem_shopId_productId_idx";

-- AlterTable
ALTER TABLE "AdsHourlyMetric" DROP COLUMN "capturedAt",
DROP COLUMN "channel",
DROP COLUMN "dateHour",
DROP COLUMN "gmvBroadDeltaCents",
DROP COLUMN "gmvBroadRawCents",
DROP COLUMN "gmvDeltaCents",
DROP COLUMN "gmvDirectDeltaCents",
DROP COLUMN "gmvDirectRawCents",
DROP COLUMN "gmvRawCents",
DROP COLUMN "raw",
DROP COLUMN "spendCents",
ADD COLUMN     "broadGmv" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "broadRoas" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "broadSold" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "click" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cpc" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "ctr" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "date" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "directGmv" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "directRoas" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "directSold" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "expense" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "hour" INTEGER NOT NULL,
ADD COLUMN     "impression" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "itemId" BIGINT,
ADD COLUMN     "type" TEXT NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "actualShippingFeeCents" INTEGER DEFAULT 0,
ADD COLUMN     "commFeeCents" INTEGER DEFAULT 0,
ADD COLUMN     "escrowAmountCents" INTEGER DEFAULT 0,
ADD COLUMN     "serviceFeeCents" INTEGER DEFAULT 0,
ADD COLUMN     "totalAmountCents" INTEGER DEFAULT 0,
ADD COLUMN     "transactionFeeCents" INTEGER DEFAULT 0;

-- AlterTable
ALTER TABLE "OrderAddressChangeAlert" DROP COLUMN "detectedAt",
DROP COLUMN "orderAddressSnapshotId",
DROP COLUMN "resolvedAt",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "OrderAdsAttribution" DROP COLUMN "amountCents",
DROP COLUMN "channel",
DROP COLUMN "confidence",
DROP COLUMN "matchedAt",
DROP COLUMN "matchedHour",
DROP COLUMN "orderCreateTime",
DROP COLUMN "rule",
ADD COLUMN     "adsType" TEXT,
ADD COLUMN     "channelId" INTEGER,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "matchConfidence" "AdsMatchConfidence" NOT NULL DEFAULT 'LOW',
ADD COLUMN     "orderSn" TEXT NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "OrderItem" DROP COLUMN "gmvCents",
DROP COLUMN "name",
DROP COLUMN "priceCents",
DROP COLUMN "sku",
ADD COLUMN     "dealPrice" INTEGER,
ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "itemName" TEXT,
ADD COLUMN     "itemSku" TEXT,
ADD COLUMN     "modelName" TEXT,
ADD COLUMN     "modelSku" TEXT,
ADD COLUMN     "orderPrice" INTEGER,
ADD COLUMN     "variationPrice" INTEGER,
ADD COLUMN     "weight" DOUBLE PRECISION,
ALTER COLUMN "itemId" SET NOT NULL,
ALTER COLUMN "quantity" DROP NOT NULL,
ALTER COLUMN "quantity" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "costCents" INTEGER DEFAULT 0;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "taxRate" DOUBLE PRECISION DEFAULT 0;

-- CreateIndex
CREATE INDEX "AdsHourlyMetric_shopId_date_idx" ON "AdsHourlyMetric"("shopId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AdsHourlyMetric_shopId_date_hour_type_itemId_key" ON "AdsHourlyMetric"("shopId", "date", "hour", "type", "itemId");

-- CreateIndex
CREATE INDEX "OrderAddressChangeAlert_orderId_idx" ON "OrderAddressChangeAlert"("orderId");

-- CreateIndex
CREATE INDEX "OrderAddressChangeAlert_status_idx" ON "OrderAddressChangeAlert"("status");

-- CreateIndex
CREATE INDEX "OrderAdsAttribution_shopId_orderSn_idx" ON "OrderAdsAttribution"("shopId", "orderSn");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");
