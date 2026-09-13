ALTER TABLE "Company"
ADD COLUMN "anymarketIntegrationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "anymarketApiBaseUrl" TEXT,
ADD COLUMN "anymarketPlatform" TEXT,
ADD COLUMN "anymarketToken" TEXT;
