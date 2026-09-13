ALTER TABLE "Company"
ADD COLUMN "integrationManualStatuses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
