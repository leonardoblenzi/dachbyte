-- CreateTable
CREATE TABLE "Order" (
    "id" SERIAL NOT NULL,
    "shopId" INTEGER NOT NULL,
    "orderSn" TEXT NOT NULL,
    "orderStatus" TEXT,
    "region" TEXT,
    "currency" TEXT,
    "daysToShip" INTEGER,
    "shipByDate" TIMESTAMP(3),
    "shopeeCreateTime" TIMESTAMP(3),
    "shopeeUpdateTime" TIMESTAMP(3),
    "bookingSn" TEXT,
    "cod" BOOLEAN,
    "advancePackage" BOOLEAN,
    "hotListingOrder" BOOLEAN,
    "isBuyerShopCollection" BOOLEAN,
    "messageToSeller" TEXT,
    "reverseShippingFee" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderAddressSnapshot" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "town" TEXT,
    "district" TEXT,
    "city" TEXT,
    "state" TEXT,
    "region" TEXT,
    "zipcode" TEXT,
    "fullAddress" TEXT,
    "addressHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderAddressSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Order_shopId_orderStatus_idx" ON "Order"("shopId", "orderStatus");

-- CreateIndex
CREATE INDEX "Order_shopId_shipByDate_idx" ON "Order"("shopId", "shipByDate");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shopId_orderSn_key" ON "Order"("shopId", "orderSn");

-- CreateIndex
CREATE INDEX "OrderAddressSnapshot_orderId_createdAt_idx" ON "OrderAddressSnapshot"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderAddressSnapshot_addressHash_idx" ON "OrderAddressSnapshot"("addressHash");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAddressSnapshot" ADD CONSTRAINT "OrderAddressSnapshot_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
