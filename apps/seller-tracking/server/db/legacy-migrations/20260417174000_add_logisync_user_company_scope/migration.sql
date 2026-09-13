ALTER TABLE "LogisyncUser"
ADD COLUMN "companyId" TEXT;

CREATE INDEX "LogisyncUser_companyId_idx"
ON "LogisyncUser"("companyId");

ALTER TABLE "LogisyncUser"
ADD CONSTRAINT "LogisyncUser_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "Company"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
