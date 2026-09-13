-- CreateTable
CREATE TABLE "Product" (
    "id" SERIAL NOT NULL,
    "shopId" INTEGER NOT NULL,
    "itemId" BIGINT NOT NULL,
    "status" TEXT,
    "title" TEXT,
    "description" TEXT,
    "currency" TEXT,
    "priceMin" INTEGER,
    "priceMax" INTEGER,
    "stock" INTEGER,
    "sold" INTEGER,
    "hasModel" BOOLEAN,
    "brand" TEXT,
    "categoryId" BIGINT,
    "shopeeUpdateTime" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductImage" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "url" TEXT NOT NULL,

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductModel" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "modelId" BIGINT NOT NULL,
    "name" TEXT,
    "sku" TEXT,
    "price" INTEGER,
    "stock" INTEGER,
    "sold" INTEGER,

    CONSTRAINT "ProductModel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Product_shopId_status_idx" ON "Product"("shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Product_shopId_itemId_key" ON "Product"("shopId", "itemId");

-- CreateIndex
CREATE INDEX "ProductImage_productId_idx" ON "ProductImage"("productId");

-- CreateIndex
CREATE INDEX "ProductModel_productId_idx" ON "ProductModel"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductModel_productId_modelId_key" ON "ProductModel"("productId", "modelId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductModel" ADD CONSTRAINT "ProductModel_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
