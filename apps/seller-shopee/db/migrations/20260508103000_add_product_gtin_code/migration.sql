-- Migration: 20260508103000_add_product_gtin_code
-- Module: shopee
-- Purpose: Persist GTIN/EAN from Shopee product APIs for cross-channel SKU matching

BEGIN;

ALTER TABLE IF EXISTS "Product"
  ADD COLUMN IF NOT EXISTS "gtinCode" TEXT;

ALTER TABLE IF EXISTS "ProductModel"
  ADD COLUMN IF NOT EXISTS "gtinCode" TEXT;

CREATE INDEX IF NOT EXISTS "Product_gtinCode_idx"
  ON "Product" ("gtinCode")
  WHERE "gtinCode" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ProductModel_gtinCode_idx"
  ON "ProductModel" ("gtinCode")
  WHERE "gtinCode" IS NOT NULL;

COMMIT;
