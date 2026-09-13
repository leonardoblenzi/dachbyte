ALTER TABLE "Order"
ADD COLUMN "originalQuotedFreightValue" DOUBLE PRECISION,
ADD COLUMN "originalQuotedFreightDate" TIMESTAMP(3),
ADD COLUMN "originalQuotedFreightDetails" JSONB,
ADD COLUMN "originalQuotedFreightQuotationId" TEXT,
ADD COLUMN "recalculatedFreightValue" DOUBLE PRECISION,
ADD COLUMN "recalculatedFreightDate" TIMESTAMP(3),
ADD COLUMN "recalculatedFreightDetails" JSONB;

CREATE TABLE "TrayCheckoutQuote" (
  "id" TEXT NOT NULL,
  "companyIdValue" TEXT,
  "trayStoreId" TEXT,
  "token" TEXT,
  "sessionId" TEXT,
  "originZipCode" TEXT,
  "destinationZipCode" TEXT,
  "productsRaw" JSONB,
  "productsHash" TEXT,
  "quotationId" TEXT NOT NULL,
  "shippingId" TEXT,
  "shipmentType" TEXT,
  "serviceCode" TEXT,
  "serviceName" TEXT,
  "integrator" TEXT,
  "quotedValue" DOUBLE PRECISION,
  "minPeriod" INTEGER,
  "maxPeriod" INTEGER,
  "selectedPossible" BOOLEAN,
  "snapshotData" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TrayCheckoutQuote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrayCheckoutQuote_quotationId_key" ON "TrayCheckoutQuote"("quotationId");
CREATE INDEX "Order_originalQuotedFreightQuotationId_idx" ON "Order"("originalQuotedFreightQuotationId");
CREATE INDEX "TrayCheckoutQuote_companyIdValue_idx" ON "TrayCheckoutQuote"("companyIdValue");
CREATE INDEX "TrayCheckoutQuote_trayStoreId_idx" ON "TrayCheckoutQuote"("trayStoreId");
CREATE INDEX "TrayCheckoutQuote_sessionId_idx" ON "TrayCheckoutQuote"("sessionId");
CREATE INDEX "TrayCheckoutQuote_productsHash_idx" ON "TrayCheckoutQuote"("productsHash");

ALTER TABLE "TrayCheckoutQuote"
ADD CONSTRAINT "TrayCheckoutQuote_companyIdValue_fkey"
FOREIGN KEY ("companyIdValue") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
