-- CreateTable
CREATE TABLE "OrderAddressChangeAlert" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "oldSnapshotId" INTEGER,
    "newSnapshotId" INTEGER NOT NULL,
    "oldHash" TEXT,
    "newHash" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "orderAddressSnapshotId" INTEGER,

    CONSTRAINT "OrderAddressChangeAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderAddressChangeAlert_orderId_detectedAt_idx" ON "OrderAddressChangeAlert"("orderId", "detectedAt");

-- CreateIndex
CREATE INDEX "OrderAddressChangeAlert_resolvedAt_idx" ON "OrderAddressChangeAlert"("resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderAddressChangeAlert_orderId_newHash_key" ON "OrderAddressChangeAlert"("orderId", "newHash");

-- AddForeignKey
ALTER TABLE "OrderAddressChangeAlert" ADD CONSTRAINT "OrderAddressChangeAlert_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAddressChangeAlert" ADD CONSTRAINT "OrderAddressChangeAlert_oldSnapshotId_fkey" FOREIGN KEY ("oldSnapshotId") REFERENCES "OrderAddressSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAddressChangeAlert" ADD CONSTRAINT "OrderAddressChangeAlert_newSnapshotId_fkey" FOREIGN KEY ("newSnapshotId") REFERENCES "OrderAddressSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAddressChangeAlert" ADD CONSTRAINT "OrderAddressChangeAlert_orderAddressSnapshotId_fkey" FOREIGN KEY ("orderAddressSnapshotId") REFERENCES "OrderAddressSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
