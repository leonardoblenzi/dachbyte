"use strict";

const { query, queryOne } = require("../config/postgres");

let ensurePriceUpdateTablePromise = null;

function isMissingPriceUpdateTableError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const searchSpace = `${String(error?.message || "")} ${String(error?.detail || "")} ${String(error?.details || "")}`
    .toLowerCase();
  return code === "42P01" && searchSpace.includes("productpriceupdateevent");
}

function toNumberOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPriceAmountOrNull(value) {
  const numeric = toNumberOrNull(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 100) / 100;
}

function toBigIntString(value) {
  if (value == null || value === "") return null;
  try {
    return BigInt(String(value)).toString();
  } catch (_error) {
    return null;
  }
}

async function ensureProductPriceUpdateEventTable() {
  if (ensurePriceUpdateTablePromise) return ensurePriceUpdateTablePromise;

  ensurePriceUpdateTablePromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS "ProductPriceUpdateEvent" (
        "id" SERIAL NOT NULL,
        "eventKey" TEXT NOT NULL,
        "shopId" INTEGER NOT NULL,
        "itemId" BIGINT NOT NULL,
        "modelId" BIGINT NULL,
        "updateField" TEXT NOT NULL,
        "oldValue" NUMERIC(18, 6) NULL,
        "newValue" NUMERIC(18, 6) NULL,
        "updateTime" TIMESTAMP(3) NOT NULL,
        "pushTimestamp" TIMESTAMP(3) NULL,
        "isBlockedForPromotion" BOOLEAN NOT NULL DEFAULT false,
        "lockUntil" TIMESTAMP(3) NULL,
        payload JSONB NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ProductPriceUpdateEvent_pkey" PRIMARY KEY ("id")
      )
    `);
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ProductPriceUpdateEvent_eventKey_key"
        ON "ProductPriceUpdateEvent"("eventKey")
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS "ProductPriceUpdateEvent_shopId_updateTime_idx"
        ON "ProductPriceUpdateEvent"("shopId", "updateTime" DESC)
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS "ProductPriceUpdateEvent_shopId_itemId_lockUntil_idx"
        ON "ProductPriceUpdateEvent"("shopId", "itemId", "lockUntil" DESC)
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS "ProductPriceUpdateEvent_shopId_blocked_lockUntil_idx"
        ON "ProductPriceUpdateEvent"("shopId", "isBlockedForPromotion", "lockUntil" DESC)
    `);
  })().catch((error) => {
    ensurePriceUpdateTablePromise = null;
    throw error;
  });

  return ensurePriceUpdateTablePromise;
}

function normalizeItemIds(itemIds = []) {
  return Array.from(
    new Set(
      (Array.isArray(itemIds) ? itemIds : [])
        .map((value) => toBigIntString(value))
        .filter(Boolean),
    ),
  );
}

function mapPriceUpdateRow(row) {
  return {
    id: Number(row.id),
    shopId: Number(row.shop_id),
    itemId: row.item_id == null ? null : BigInt(row.item_id),
    modelId: row.model_id == null ? null : BigInt(row.model_id),
    updateField: row.update_field || null,
    oldValue: toNumberOrNull(row.old_value),
    newValue: toNumberOrNull(row.new_value),
    updateTime: row.update_time || null,
    pushTimestamp: row.push_timestamp || null,
    isBlockedForPromotion: Boolean(row.is_blocked_for_promotion),
    lockUntil: row.lock_until || null,
    productTitle: row.product_title || null,
    itemSku: row.item_sku || null,
  };
}

async function insertPriceUpdateEvent({
  eventKey,
  shopId,
  itemId,
  modelId = null,
  updateField,
  oldValue = null,
  newValue = null,
  updateTime,
  pushTimestamp = null,
  isBlockedForPromotion = false,
  lockUntil = null,
  payload = null,
}) {
  try {
    await ensureProductPriceUpdateEventTable();
    const row = await queryOne(
      `
      INSERT INTO "ProductPriceUpdateEvent" (
        "eventKey",
        "shopId",
        "itemId",
        "modelId",
        "updateField",
        "oldValue",
        "newValue",
        "updateTime",
        "pushTimestamp",
        "isBlockedForPromotion",
        "lockUntil",
        payload
      )
      VALUES (
        $1,
        $2,
        $3::bigint,
        $4::bigint,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12::jsonb
      )
      ON CONFLICT ("eventKey")
      DO UPDATE SET
        "updatedAt" = NOW()
      RETURNING id
    `,
      [
        String(eventKey || ""),
        Number(shopId),
        toBigIntString(itemId),
        toBigIntString(modelId),
        String(updateField || ""),
        oldValue == null ? null : Number(oldValue),
        newValue == null ? null : Number(newValue),
        updateTime,
        pushTimestamp,
        Boolean(isBlockedForPromotion),
        lockUntil,
        payload ? JSON.stringify(payload) : null,
      ],
    );

    return Number(row?.id || 0) || null;
  } catch (error) {
    if (isMissingPriceUpdateTableError(error)) {
      console.warn(
        '[priceIncreaseSqlRepository] tabela "ProductPriceUpdateEvent" ausente; evento ignorado temporariamente.',
      );
      return null;
    }
    throw error;
  }
}

async function updateCachedProductPriceFromPush({
  shopId,
  itemId,
  modelId = null,
  newValue = null,
}) {
  const price = toPriceAmountOrNull(newValue);
  const normalizedItemId = toBigIntString(itemId);
  const normalizedModelId = toBigIntString(modelId);
  if (!Number.isFinite(Number(shopId)) || !normalizedItemId || price == null) {
    return {
      productUpdated: false,
      modelUpdated: false,
      reason: "invalid_price_update_payload",
    };
  }

  const productRow = await queryOne(
    `
      SELECT id, title, "itemSku", "priceMin", "priceMax"
      FROM "Product"
      WHERE "shopId" = $1
        AND "itemId" = $2::bigint
      LIMIT 1
    `,
    [Number(shopId), normalizedItemId],
  );

  if (!productRow) {
    return {
      productUpdated: false,
      modelUpdated: false,
      reason: "product_not_found",
    };
  }

  let modelUpdated = false;
  if (normalizedModelId) {
    const modelRow = await queryOne(
      `
        UPDATE "ProductModel"
        SET price = $3
        WHERE "productId" = $1
          AND "modelId" = $2::bigint
        RETURNING id
      `,
      [Number(productRow.id), normalizedModelId, price],
    );
    modelUpdated = Boolean(modelRow?.id);
  }

  if (modelUpdated) {
    await queryOne(
      `
        UPDATE "Product" p
        SET
          "priceMin" = price_range.min_price,
          "priceMax" = price_range.max_price,
          "updatedAt" = NOW()
        FROM (
          SELECT
            "productId",
            MIN(price) AS min_price,
            MAX(price) AS max_price
          FROM "ProductModel"
          WHERE "productId" = $1
            AND price IS NOT NULL
          GROUP BY "productId"
        ) price_range
        WHERE p.id = price_range."productId"
        RETURNING p.id
      `,
      [Number(productRow.id)],
    );
  } else {
    await queryOne(
      `
        UPDATE "Product"
        SET
          "priceMin" = $3,
          "priceMax" = $3,
          "updatedAt" = NOW()
        WHERE "shopId" = $1
          AND "itemId" = $2::bigint
        RETURNING id
      `,
      [Number(shopId), normalizedItemId, price],
    );
  }

  return {
    productUpdated: true,
    modelUpdated,
    productId: Number(productRow.id),
    title: productRow.title || null,
    itemSku: productRow.itemSku || null,
    previousPriceMin: toNumberOrNull(productRow.priceMin),
    previousPriceMax: toNumberOrNull(productRow.priceMax),
    cachedPrice: price,
  };
}

async function listActivePriceLocksByItemIds(shopId, itemIds = [], at = new Date()) {
  const normalizedItemIds = normalizeItemIds(itemIds);
  if (!normalizedItemIds.length) return new Map();

  try {
    await ensureProductPriceUpdateEventTable();
    const result = await query(
      `
      SELECT
        e."itemId" AS item_id,
        MAX(e."lockUntil") AS lock_until,
        MAX(e."updateTime") AS update_time,
        COUNT(*)::int AS lock_count
      FROM "ProductPriceUpdateEvent" e
      WHERE e."shopId" = $1
        AND e."isBlockedForPromotion" = true
        AND e."lockUntil" > $2
        AND e."itemId" = ANY($3::bigint[])
      GROUP BY e."itemId"
    `,
      [Number(shopId), at, normalizedItemIds],
    );

    return new Map(
      result.rows.map((row) => [
        String(row.item_id),
        {
          itemId: row.item_id == null ? null : BigInt(row.item_id),
          lockUntil: row.lock_until || null,
          updateTime: row.update_time || null,
          lockCount: Number(row.lock_count || 0),
        },
      ]),
    );
  } catch (error) {
    if (isMissingPriceUpdateTableError(error)) {
      return new Map();
    }
    throw error;
  }
}

async function listRecentPriceUpdateEvents(
  shopId,
  {
    onlyBlocked = false,
    limit = 100,
    offset = 0,
    search = "",
  } = {},
) {
  const params = [Number(shopId)];
  const clauses = [`e."shopId" = $1`];

  if (onlyBlocked) {
    clauses.push(`e."isBlockedForPromotion" = true`);
  }

  const normalizedSearch = String(search || "").trim();
  if (normalizedSearch) {
    params.push(`%${normalizedSearch}%`);
    const searchParam = `$${params.length}`;
    clauses.push(`(
      e."itemId"::text ILIKE ${searchParam}
      OR e."modelId"::text ILIKE ${searchParam}
      OR p.title ILIKE ${searchParam}
      OR p."itemSku" ILIKE ${searchParam}
    )`);
  }

  params.push(Math.max(1, Math.min(500, Number(limit) || 100)));
  const limitParam = `$${params.length}`;
  params.push(Math.max(0, Number(offset) || 0));
  const offsetParam = `$${params.length}`;

  try {
    await ensureProductPriceUpdateEventTable();
    const [totalRow, result] = await Promise.all([
      queryOne(
        `
        SELECT COUNT(*)::int AS total
        FROM "ProductPriceUpdateEvent" e
        LEFT JOIN "Product" p
          ON p."shopId" = e."shopId"
         AND p."itemId" = e."itemId"
        WHERE ${clauses.join("\n          AND ")}
      `,
        params.slice(0, params.length - 2),
      ),
      query(
      `
      SELECT
        e.id,
        e."shopId" AS shop_id,
        e."itemId" AS item_id,
        e."modelId" AS model_id,
        e."updateField" AS update_field,
        e."oldValue" AS old_value,
        e."newValue" AS new_value,
        e."updateTime" AS update_time,
        e."pushTimestamp" AS push_timestamp,
        e."isBlockedForPromotion" AS is_blocked_for_promotion,
        e."lockUntil" AS lock_until,
        p.title AS product_title,
        p."itemSku" AS item_sku
      FROM "ProductPriceUpdateEvent" e
      LEFT JOIN "Product" p
        ON p."shopId" = e."shopId"
       AND p."itemId" = e."itemId"
      WHERE ${clauses.join("\n        AND ")}
      ORDER BY e."updateTime" DESC, e.id DESC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    `,
      params,
      ),
    ]);

    return {
      total: Number(totalRow?.total || 0),
      items: result.rows.map(mapPriceUpdateRow),
    };
  } catch (error) {
    if (isMissingPriceUpdateTableError(error)) {
      return {
        total: 0,
        items: [],
      };
    }
    throw error;
  }
}

async function getPriceIncreaseDashboardSummary(shopId, at = new Date()) {
  try {
    await ensureProductPriceUpdateEventTable();
    const [activeRow, recentRow] = await Promise.all([
      queryOne(
        `
        SELECT
          COUNT(DISTINCT e."itemId")::int AS blocked_items
        FROM "ProductPriceUpdateEvent" e
        WHERE e."shopId" = $1
          AND e."isBlockedForPromotion" = true
          AND e."lockUntil" > $2
      `,
        [Number(shopId), at],
      ),
      queryOne(
        `
        SELECT
          COUNT(*)::int AS total_recent_events
        FROM "ProductPriceUpdateEvent" e
        WHERE e."shopId" = $1
          AND e."updateTime" >= ($2::timestamp - INTERVAL '7 days')
      `,
        [Number(shopId), at],
      ),
    ]);

    return {
      blockedItems: Number(activeRow?.blocked_items || 0),
      totalRecentEvents: Number(recentRow?.total_recent_events || 0),
    };
  } catch (error) {
    if (isMissingPriceUpdateTableError(error)) {
      return {
        blockedItems: 0,
        totalRecentEvents: 0,
      };
    }
    throw error;
  }
}

module.exports = {
  ensureProductPriceUpdateEventTable,
  insertPriceUpdateEvent,
  updateCachedProductPriceFromPush,
  listActivePriceLocksByItemIds,
  listRecentPriceUpdateEvents,
  getPriceIncreaseDashboardSummary,
  _test: {
    toPriceAmountOrNull,
  },
};
