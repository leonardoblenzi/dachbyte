ALTER TABLE "Company"
ADD COLUMN "blingIntegrationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "magazordIntegrationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "sysempIntegrationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "magazordApiBaseUrl" TEXT,
ADD COLUMN "magazordApiUser" TEXT,
ADD COLUMN "magazordApiPassword" TEXT;
