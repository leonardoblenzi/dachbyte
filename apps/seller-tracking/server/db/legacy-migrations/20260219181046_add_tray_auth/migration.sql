-- CreateTable
CREATE TABLE "TrayAuth" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "storeName" TEXT,
    "apiAddress" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "code" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrayAuth_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrayAuth_storeId_key" ON "TrayAuth"("storeId");
