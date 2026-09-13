ALTER TABLE "Order"
  ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "manualCustomStatus" TEXT,
  ADD COLUMN "observation" TEXT;

ALTER TABLE "MonitoredOrder"
  ADD COLUMN "watchEvents" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "SyncNotification"
  ADD COLUMN "readAt" TIMESTAMP(3);

CREATE TABLE "CompanyOrderCustomStatus" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CompanyOrderCustomStatus_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CompanyOrderCustomStatus_companyId_label_key"
  ON "CompanyOrderCustomStatus"("companyId", "label");

CREATE INDEX "CompanyOrderCustomStatus_company_created_idx"
  ON "CompanyOrderCustomStatus"("companyId", "createdAt");

CREATE INDEX "Order_archived_company_idx"
  ON "Order"("isArchived", "companyId");

CREATE INDEX "SyncNotification_company_read_created_idx"
  ON "SyncNotification"("companyId", "readAt", "createdAt");

ALTER TABLE "CompanyOrderCustomStatus"
  ADD CONSTRAINT "CompanyOrderCustomStatus_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CompanyOrderCustomStatus"
  ADD CONSTRAINT "CompanyOrderCustomStatus_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
