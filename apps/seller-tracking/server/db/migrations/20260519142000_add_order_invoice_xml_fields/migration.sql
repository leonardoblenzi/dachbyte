-- Migration: 20260519142000_add_order_invoice_xml_fields
-- Module: avantracking
-- Purpose: Add invoice XML metadata fields and revisit control state to Order

BEGIN;

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "invoiceAccessKey" TEXT,
  ADD COLUMN IF NOT EXISTS "invoiceXmlUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "invoiceXmlRevisitState" TEXT;

CREATE INDEX IF NOT EXISTS "Order_invoiceAccessKey_idx" ON "Order"("invoiceAccessKey");
CREATE INDEX IF NOT EXISTS "Order_invoiceXmlRevisitState_idx" ON "Order"("invoiceXmlRevisitState");

COMMIT;
