ALTER TABLE "TrayAuth"
ADD COLUMN "companyId" TEXT;

DROP INDEX IF EXISTS "TrayAuth_storeId_key";

CREATE UNIQUE INDEX "TrayAuth_companyId_key" ON "TrayAuth"("companyId");

ALTER TABLE "TrayAuth"
ADD CONSTRAINT "TrayAuth_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "Company"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
