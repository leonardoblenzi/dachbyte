CREATE TABLE "MonitoredOrder" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MonitoredOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SyncNotification" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SyncNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MonitoredOrder_companyId_orderId_key"
  ON "MonitoredOrder"("companyId", "orderId");

CREATE INDEX "MonitoredOrder_company_created_idx"
  ON "MonitoredOrder"("companyId", "createdAt");

CREATE INDEX "SyncNotification_company_created_idx"
  ON "SyncNotification"("companyId", "createdAt");

CREATE INDEX "SyncNotification_company_category_created_idx"
  ON "SyncNotification"("companyId", "category", "createdAt");

ALTER TABLE "MonitoredOrder"
  ADD CONSTRAINT "MonitoredOrder_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MonitoredOrder"
  ADD CONSTRAINT "MonitoredOrder_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MonitoredOrder"
  ADD CONSTRAINT "MonitoredOrder_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SyncNotification"
  ADD CONSTRAINT "SyncNotification_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
