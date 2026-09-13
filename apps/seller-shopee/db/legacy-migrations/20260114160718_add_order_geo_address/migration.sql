-- CreateTable
CREATE TABLE "OrderGeoAddress" (
    "id" SERIAL NOT NULL,
    "shopId" INTEGER NOT NULL,
    "orderId" INTEGER NOT NULL,
    "orderSn" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "stateNorm" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "cityNorm" TEXT NOT NULL,
    "zipcode" TEXT,
    "fullAddress" TEXT,
    "shopeeCreateTime" TIMESTAMP(3),
    "shopeeUpdateTime" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderGeoAddress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderGeoAddress_orderId_key" ON "OrderGeoAddress"("orderId");

-- CreateIndex
CREATE INDEX "OrderGeoAddress_shopId_stateNorm_idx" ON "OrderGeoAddress"("shopId", "stateNorm");

-- CreateIndex
CREATE INDEX "OrderGeoAddress_shopId_stateNorm_cityNorm_idx" ON "OrderGeoAddress"("shopId", "stateNorm", "cityNorm");

-- CreateIndex
CREATE INDEX "OrderGeoAddress_shopId_shopeeCreateTime_idx" ON "OrderGeoAddress"("shopId", "shopeeCreateTime");

-- CreateIndex
CREATE UNIQUE INDEX "OrderGeoAddress_shopId_orderSn_key" ON "OrderGeoAddress"("shopId", "orderSn");

-- AddForeignKey
ALTER TABLE "OrderGeoAddress" ADD CONSTRAINT "OrderGeoAddress_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderGeoAddress" ADD CONSTRAINT "OrderGeoAddress_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
