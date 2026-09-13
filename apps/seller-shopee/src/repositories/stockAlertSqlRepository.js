"use strict";

const { query, withClient } = require("../config/postgres");

const SALES_EXCLUDED_STATUSES = ["CANCELLED", "UNPAID", "TO_RETURN", "IN_CANCEL"];

let ensureTablePromise = null;

function normalizeItemId(value) {
  if (value == null || value === "") return null;
  try {
    return BigInt(String(value)).toString();
  } catch (_error) {
    return null;
  }
}

function normalizeItemIds(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => normalizeItemId(value))
        .filter(Boolean),
    ),
  );
}

function toNumberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function ensureStockAlertTable() {
  if (ensureTablePromise) return ensureTablePromise;

  ensureTablePromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS "StockAlertMonitor" (
        "id" SERIAL NOT NULL,
        "shopId" INTEGER NOT NULL,
        "itemId" BIGINT NOT NULL,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        status TEXT NOT NULL DEFAULT 'monitoring',
        "expectedArrivalDate" DATE NULL,
        "purchaseMarkedAt" TIMESTAMP(3) NULL,
        "lastKnownStock" INTEGER NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "StockAlertMonitor_pkey" PRIMARY KEY ("id")
      )
    `);

    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "StockAlertMonitor_shopId_itemId_key"
      ON "StockAlertMonitor"("shopId", "itemId")
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS "StockAlertMonitor_shopId_isActive_idx"
      ON "StockAlertMonitor"("shopId", "isActive")
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS "StockAlertMonitor_shopId_status_expectedArrival_idx"
      ON "StockAlertMonitor"("shopId", status, "expectedArrivalDate")
    `);

    await query(`
      DO $$
      BEGIN
        IF to_regclass('public."Shop"') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'StockAlertMonitor_shopId_fkey'
          ) THEN
          ALTER TABLE "StockAlertMonitor"
            ADD CONSTRAINT "StockAlertMonitor_shopId_fkey"
            FOREIGN KEY ("shopId") REFERENCES "Shop"("id")
            ON DELETE CASCADE
            ON UPDATE CASCADE;
        END IF;
      END $$;
    `);
  })().catch((error) => {
    ensureTablePromise = null;
    throw error;
  });

  return ensureTablePromise;
}

async function listMonitoredItems(shopId) {
  await ensureStockAlertTable();
  const result = await query(
    `
      SELECT
        "itemId",
        "isActive",
        status,
        "expectedArrivalDate",
        "purchaseMarkedAt",
        "lastKnownStock",
        "updatedAt"
      FROM "StockAlertMonitor"
      WHERE "shopId" = $1
        AND "isActive" = true
      ORDER BY "updatedAt" DESC, id DESC
    `,
    [Number(shopId)],
  );

  return result.rows.map((row) => ({
    itemId: normalizeItemId(row.itemId),
    isActive: Boolean(row.isActive),
    status: String(row.status || "monitoring"),
    expectedArrivalDate: row.expectedArrivalDate || null,
    purchaseMarkedAt: row.purchaseMarkedAt || null,
    lastKnownStock: row.lastKnownStock == null ? null : Number(row.lastKnownStock),
    updatedAt: row.updatedAt || null,
  }));
}

async function upsertMonitoredItems(shopId, itemIds = []) {
  await ensureStockAlertTable();
  const normalized = normalizeItemIds(itemIds);
  if (!normalized.length) return { upserted: 0 };

  await query(
    `
      INSERT INTO "StockAlertMonitor" (
        "shopId",
        "itemId",
        "isActive",
        status,
        "createdAt",
        "updatedAt"
      )
      SELECT
        $1::integer,
        x."itemId",
        true,
        'monitoring',
        NOW(),
        NOW()
      FROM jsonb_to_recordset($2::jsonb) AS x("itemId" bigint)
      ON CONFLICT ("shopId", "itemId")
      DO UPDATE SET
        "isActive" = true,
        "updatedAt" = NOW(),
        status = CASE
          WHEN "StockAlertMonitor".status = 'awaiting_arrival'
            THEN "StockAlertMonitor".status
          ELSE 'monitoring'
        END
    `,
    [Number(shopId), JSON.stringify(normalized.map((itemId) => ({ itemId })))],
  );

  return { upserted: normalized.length };
}

async function setItemPurchaseInTransit(shopId, itemId, expectedArrivalDate, lastKnownStock) {
  await ensureStockAlertTable();
  const normalizedItemId = normalizeItemId(itemId);
  if (!normalizedItemId) return false;

  const result = await query(
    `
      UPDATE "StockAlertMonitor"
      SET
        "isActive" = true,
        status = 'awaiting_arrival',
        "expectedArrivalDate" = $3::date,
        "purchaseMarkedAt" = NOW(),
        "lastKnownStock" = $4::integer,
        "updatedAt" = NOW()
      WHERE "shopId" = $1
        AND "itemId" = $2::bigint
      RETURNING id
    `,
    [Number(shopId), normalizedItemId, expectedArrivalDate, Number(lastKnownStock || 0)],
  );
  return result.rowCount > 0;
}

async function confirmArrival(shopId, itemId) {
  await ensureStockAlertTable();
  const normalizedItemId = normalizeItemId(itemId);
  if (!normalizedItemId) return false;

  const result = await query(
    `
      UPDATE "StockAlertMonitor"
      SET
        status = 'monitoring',
        "expectedArrivalDate" = NULL,
        "purchaseMarkedAt" = NULL,
        "lastKnownStock" = NULL,
        "updatedAt" = NOW()
      WHERE "shopId" = $1
        AND "itemId" = $2::bigint
      RETURNING id
    `,
    [Number(shopId), normalizedItemId],
  );
  return result.rowCount > 0;
}

async function disableMonitoredItem(shopId, itemId) {
  await ensureStockAlertTable();
  const normalizedItemId = normalizeItemId(itemId);
  if (!normalizedItemId) return false;

  const result = await query(
    `
      UPDATE "StockAlertMonitor"
      SET
        "isActive" = false,
        status = 'monitoring',
        "expectedArrivalDate" = NULL,
        "purchaseMarkedAt" = NULL,
        "lastKnownStock" = NULL,
        "updatedAt" = NOW()
      WHERE "shopId" = $1
        AND "itemId" = $2::bigint
      RETURNING id
    `,
    [Number(shopId), normalizedItemId],
  );

  return result.rowCount > 0;
}

async function clearAwaitingStatusWhenStockIncreased(shopId, itemId, currentStock) {
  await ensureStockAlertTable();
  const normalizedItemId = normalizeItemId(itemId);
  if (!normalizedItemId) return false;

  const result = await query(
    `
      UPDATE "StockAlertMonitor"
      SET
        status = 'monitoring',
        "expectedArrivalDate" = NULL,
        "purchaseMarkedAt" = NULL,
        "lastKnownStock" = NULL,
        "updatedAt" = NOW()
      WHERE "shopId" = $1
        AND "itemId" = $2::bigint
        AND status = 'awaiting_arrival'
        AND COALESCE("lastKnownStock", -1) < $3::integer
      RETURNING id
    `,
    [Number(shopId), normalizedItemId, Number(currentStock || 0)],
  );

  return result.rowCount > 0;
}

async function searchProductsForMonitoring(shopId, q = "", limit = 30) {
  const queryText = String(q || "").trim();
  const normalizedItemId = normalizeItemId(queryText);
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));

  const result = await query(
    `
      SELECT
        p."itemId",
        p.title,
        p."itemSku",
        p.status,
        p."hasModel",
        p.stock,
        (
          SELECT pi.url
          FROM "ProductImage" pi
          WHERE pi."productId" = p.id
          ORDER BY pi.id ASC
          LIMIT 1
        ) AS "imageUrl",
        (
          SELECT COALESCE(SUM(pm.stock), 0)::int
          FROM "ProductModel" pm
          WHERE pm."productId" = p.id
        ) AS "modelsStock",
        p.sold,
        p."updatedAt"
      FROM "Product" p
      WHERE p."shopId" = $1
        AND UPPER(TRIM(COALESCE(p.status, ''))) <> 'DELETED'
        AND (
          $2::text = ''
          OR ($3::text <> '' AND p."itemId" = $3::bigint)
          OR COALESCE(p.title, '') ILIKE '%' || $2 || '%'
          OR COALESCE(p."itemSku", '') ILIKE '%' || $2 || '%'
        )
      ORDER BY p."updatedAt" DESC NULLS LAST, p.id DESC
      LIMIT $4
    `,
    [Number(shopId), queryText, normalizedItemId || "", safeLimit],
  );

  return result.rows.map((row) => {
    const hasModel = row.hasModel == null ? null : Boolean(row.hasModel);
    const totalStock = hasModel
      ? toNumberOrZero(row.modelsStock)
      : toNumberOrZero(row.stock);
    return {
      itemId: normalizeItemId(row.itemId),
      title: row.title || null,
      itemSku: row.itemSku || null,
      status: row.status || null,
      imageUrl: row.imageUrl || null,
      totalStock: Math.max(0, totalStock),
      sold: Math.max(0, toNumberOrZero(row.sold)),
      updatedAt: row.updatedAt || null,
    };
  });
}

async function listProductBasicsByItemIds(shopId, itemIds = []) {
  const normalized = normalizeItemIds(itemIds);
  if (!normalized.length) return [];

  const result = await query(
    `
      SELECT
        p."itemId",
        p.title,
        p."itemSku",
        p.status,
        p."hasModel",
        p.stock,
        p.sold,
        p."updatedAt",
        (
          SELECT pi.url
          FROM "ProductImage" pi
          WHERE pi."productId" = p.id
          ORDER BY pi.id ASC
          LIMIT 1
        ) AS "imageUrl",
        (
          SELECT COALESCE(SUM(pm.stock), 0)::int
          FROM "ProductModel" pm
          WHERE pm."productId" = p.id
        ) AS "modelsStock"
      FROM "Product" p
      WHERE p."shopId" = $1
        AND p."itemId" = ANY($2::bigint[])
    `,
    [Number(shopId), normalized],
  );

  return result.rows.map((row) => {
    const hasModel = row.hasModel == null ? null : Boolean(row.hasModel);
    const totalStock = hasModel
      ? toNumberOrZero(row.modelsStock)
      : toNumberOrZero(row.stock);
    return {
      itemId: normalizeItemId(row.itemId),
      title: row.title || null,
      itemSku: row.itemSku || null,
      status: row.status || null,
      imageUrl: row.imageUrl || null,
      totalStock: Math.max(0, totalStock),
      sold: Math.max(0, toNumberOrZero(row.sold)),
      updatedAt: row.updatedAt || null,
    };
  });
}

async function mapItemSalesByRange(shopId, itemIds = [], startDate, endDate) {
  const normalized = normalizeItemIds(itemIds);
  if (!normalized.length) return new Map();

  const result = await query(
    `
      SELECT
        oi."itemId" AS "itemId",
        COALESCE(SUM(oi.quantity), 0)::bigint AS quantity
      FROM "OrderItem" oi
      INNER JOIN "Order" o
        ON o.id = oi."orderId"
        AND o."shopId" = oi."shopId"
      WHERE oi."shopId" = $1
        AND oi."itemId" = ANY($2::bigint[])
        AND o."orderStatus" IS NOT NULL
        AND o."orderStatus" <> ALL($3::text[])
        AND COALESCE(o."shopeeCreateTime", o."createdAt") >= $4::timestamptz
        AND COALESCE(o."shopeeCreateTime", o."createdAt") <= $5::timestamptz
      GROUP BY oi."itemId"
    `,
    [Number(shopId), normalized, SALES_EXCLUDED_STATUSES, startDate, endDate],
  );

  return new Map(
    result.rows.map((row) => [
      normalizeItemId(row.itemId),
      Math.max(0, toNumberOrZero(row.quantity)),
    ]),
  );
}

async function syncMonitoredProductsStock(shopId, snapshots = []) {
  const normalizedSnapshots = (Array.isArray(snapshots) ? snapshots : [])
    .map((row) => {
      const itemId = normalizeItemId(row?.itemId);
      if (!itemId) return null;
      const stockRaw = Number(row?.stock);
      const stock = Number.isFinite(stockRaw) ? Math.max(0, Math.round(stockRaw)) : null;
      const models = (Array.isArray(row?.models) ? row.models : [])
        .map((model) => {
          const modelId = normalizeItemId(model?.modelId);
          if (!modelId) return null;
          const modelStockRaw = Number(model?.stock);
          const modelStock = Number.isFinite(modelStockRaw)
            ? Math.max(0, Math.round(modelStockRaw))
            : null;
          return {
            itemId,
            modelId,
            stock: modelStock,
          };
        })
        .filter(Boolean);

      return {
        itemId,
        stock,
        models,
      };
    })
    .filter(Boolean);

  if (!normalizedSnapshots.length) {
    return {
      requestedItems: 0,
      updatedProducts: 0,
      updatedModels: 0,
    };
  }

  return withClient(async (client) => {
    await client.query("BEGIN");

    try {
      const productPayload = normalizedSnapshots
        .map((row) => ({ itemId: row.itemId, stock: row.stock }));
      const productUpdate = await client.query(
        `
          UPDATE "Product" p
          SET
            stock = src.stock,
            "updatedAt" = NOW()
          FROM jsonb_to_recordset($2::jsonb) AS src("itemId" bigint, stock integer)
          WHERE p."shopId" = $1
            AND p."itemId" = src."itemId"
        `,
        [Number(shopId), JSON.stringify(productPayload)],
      );

      const modelPayload = normalizedSnapshots
        .flatMap((row) => row.models || [])
        .map((row) => ({
          itemId: row.itemId,
          modelId: row.modelId,
          stock: row.stock,
        }));

      let updatedModels = 0;
      if (modelPayload.length) {
        const modelUpdate = await client.query(
          `
            UPDATE "ProductModel" pm
            SET stock = src.stock
            FROM jsonb_to_recordset($2::jsonb) AS src(
              "itemId" bigint,
              "modelId" bigint,
              stock integer
            ),
            "Product" p
            WHERE pm."modelId" = src."modelId"
              AND p.id = pm."productId"
              AND p."shopId" = $1
              AND p."itemId" = src."itemId"
              AND pm."productId" = p.id
          `,
          [Number(shopId), JSON.stringify(modelPayload)],
        );
        updatedModels = Number(modelUpdate.rowCount || 0);
      }

      await client.query("COMMIT");
      return {
        requestedItems: normalizedSnapshots.length,
        updatedProducts: Number(productUpdate.rowCount || 0),
        updatedModels,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

module.exports = {
  listMonitoredItems,
  upsertMonitoredItems,
  setItemPurchaseInTransit,
  confirmArrival,
  disableMonitoredItem,
  clearAwaitingStatusWhenStockIncreased,
  searchProductsForMonitoring,
  listProductBasicsByItemIds,
  mapItemSalesByRange,
  syncMonitoredProductsStock,
};
