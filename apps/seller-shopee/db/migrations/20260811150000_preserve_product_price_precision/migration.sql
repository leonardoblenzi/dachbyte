-- Migration: 20260811150000_preserve_product_price_precision
-- Module: shopee
-- Purpose: Preserve Shopee price decimals and restore the latest webhook price when available.

BEGIN;

ALTER TABLE "Product"
  ALTER COLUMN "priceMin" TYPE NUMERIC(14, 2) USING "priceMin"::numeric,
  ALTER COLUMN "priceMax" TYPE NUMERIC(14, 2) USING "priceMax"::numeric;

ALTER TABLE "ProductModel"
  ALTER COLUMN price TYPE NUMERIC(14, 2) USING price::numeric;

DO $$
BEGIN
  IF to_regclass('public."ProductPriceUpdateEvent"') IS NOT NULL THEN
    WITH latest_model_price AS (
      SELECT DISTINCT ON (e."shopId", e."itemId", e."modelId")
        e."shopId",
        e."itemId",
        e."modelId",
        e."newValue"
      FROM "ProductPriceUpdateEvent" e
      WHERE e."modelId" IS NOT NULL
        AND e."newValue" IS NOT NULL
      ORDER BY e."shopId", e."itemId", e."modelId", e."updateTime" DESC, e.id DESC
    )
    UPDATE "ProductModel" pm
    SET price = latest."newValue"::numeric(14, 2)
    FROM "Product" p
    INNER JOIN latest_model_price latest
      ON latest."shopId" = p."shopId"
     AND latest."itemId" = p."itemId"
    WHERE pm."productId" = p.id
      AND pm."modelId" = latest."modelId";

    WITH latest_item_price AS (
      SELECT DISTINCT ON (e."shopId", e."itemId")
        e."shopId",
        e."itemId",
        e."newValue"
      FROM "ProductPriceUpdateEvent" e
      WHERE e."modelId" IS NULL
        AND e."newValue" IS NOT NULL
      ORDER BY e."shopId", e."itemId", e."updateTime" DESC, e.id DESC
    )
    UPDATE "Product" p
    SET
      "priceMin" = latest."newValue"::numeric(14, 2),
      "priceMax" = latest."newValue"::numeric(14, 2)
    FROM latest_item_price latest
    WHERE latest."shopId" = p."shopId"
      AND latest."itemId" = p."itemId"
      AND NOT EXISTS (
        SELECT 1
        FROM "ProductModel" pm
        WHERE pm."productId" = p.id
      );
  END IF;
END $$;

UPDATE "Product" p
SET
  "priceMin" = ranges.min_price,
  "priceMax" = ranges.max_price
FROM (
  SELECT
    "productId",
    MIN(price) AS min_price,
    MAX(price) AS max_price
  FROM "ProductModel"
  WHERE price IS NOT NULL
  GROUP BY "productId"
) ranges
WHERE p.id = ranges."productId";

COMMIT;
