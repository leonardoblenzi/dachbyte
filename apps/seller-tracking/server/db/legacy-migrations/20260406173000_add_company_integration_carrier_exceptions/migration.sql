ALTER TABLE "Company"
ADD COLUMN "integrationCarrierExceptions" TEXT[] DEFAULT ARRAY[]::TEXT[];
