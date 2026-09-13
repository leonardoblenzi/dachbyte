ALTER TABLE "Company"
  ADD COLUMN "tenantGlobalId" TEXT,
  ADD COLUMN "documentType" TEXT,
  ADD COLUMN "documentNumber" TEXT;

ALTER TABLE "User"
  ADD COLUMN "userGlobalId" TEXT;

UPDATE "Company"
SET "documentType" = UPPER(TRIM("documentType"))
WHERE "documentType" IS NOT NULL;

UPDATE "Company"
SET "documentNumber" = NULLIF(REGEXP_REPLACE(COALESCE("documentNumber", ''), '[^0-9]', '', 'g'), '')
WHERE "documentNumber" IS NOT NULL;

UPDATE "Company"
SET "documentNumber" = NULLIF(REGEXP_REPLACE(COALESCE("cnpj", ''), '[^0-9]', '', 'g'), '')
WHERE "documentNumber" IS NULL
  AND "cnpj" IS NOT NULL;

UPDATE "Company"
SET "documentType" = 'CNPJ'
WHERE "documentType" IS NULL
  AND "documentNumber" IS NOT NULL
  AND LENGTH("documentNumber") = 14;

UPDATE "Company"
SET "tenantGlobalId" = (md5(random()::text || clock_timestamp()::text || "id"::text)::uuid::text)
WHERE "tenantGlobalId" IS NULL;

UPDATE "User"
SET "userGlobalId" = (md5(random()::text || clock_timestamp()::text || "id"::text)::uuid::text)
WHERE "userGlobalId" IS NULL;

ALTER TABLE "Company"
  ADD CONSTRAINT "Company_documentType_check"
  CHECK ("documentType" IS NULL OR "documentType" IN ('CNPJ', 'CPF'));

CREATE UNIQUE INDEX "Company_tenantGlobalId_unique"
  ON "Company" ("tenantGlobalId");

CREATE INDEX "Company_document_idx"
  ON "Company" ("documentType", "documentNumber");

CREATE UNIQUE INDEX "User_userGlobalId_unique"
  ON "User" ("userGlobalId");