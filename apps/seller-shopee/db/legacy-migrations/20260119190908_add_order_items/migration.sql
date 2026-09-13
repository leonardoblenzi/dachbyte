-- CreateTable
CREATE TABLE "OrderItem" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "shopId" INTEGER NOT NULL,
    "orderId" INTEGER NOT NULL,
    "itemId" BIGINT,
    "modelId" BIGINT,
    "sku" TEXT,
    "name" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "gmvCents" INTEGER NOT NULL DEFAULT 0,
    "productId" INTEGER,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderItem_shopId_orderId_idx" ON "OrderItem"("shopId", "orderId");

-- CreateIndex
CREATE INDEX "OrderItem_shopId_itemId_idx" ON "OrderItem"("shopId", "itemId");

-- CreateIndex
CREATE INDEX "OrderItem_shopId_productId_idx" ON "OrderItem"("shopId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderItem_orderId_itemId_modelId_key" ON "OrderItem"("orderId", "itemId", "modelId");

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
