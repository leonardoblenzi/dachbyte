ALTER TABLE "Company"
ADD COLUMN "trayIntegrationEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "intelipostIntegrationEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "sswRequireEnabled" BOOLEAN NOT NULL DEFAULT true;
