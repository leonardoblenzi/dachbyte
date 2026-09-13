"use strict";

const { query, queryOne, withClient } = require("../config/postgres");

let ensureProductSyncStatePromise = null;

function toBigIntString(value) {
  return BigInt(String(value)).toString();
}

function parseNumberLike(value) {
  if (value == null || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "string") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  const raw = value.trim();
  if (!raw) {
    return null;
  }

  let normalized = raw;
  const hasComma = normalized.includes(",");
  const hasDot = normalized.includes(".");

  if (hasComma && hasDot) {
    if (normalized.lastIndexOf(",") > normalized.lastIndexOf(".")) {
      normalized = normalized.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = normalized.replace(/,/g, "");
    }
  } else if (hasComma) {
    normalized = normalized.replace(",", ".");
  }

  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

function toIntOrNull(value) {
  const numeric = parseNumberLike(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.round(numeric);
}

function toMoneyOrNull(value) {
  const numeric = parseNumberLike(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.round(numeric * 100) / 100;
}

function isMissingGtinColumnError(error) {
  if (String(error?.code || "") !== "42703") return false;
  const detail = String(error?.detail || "");
  const message = String(error?.message || "");
  return /gtinCode/i.test(`${detail} ${message}`);
}

function normalizeProductModels(models = []) {
  const byModelId = new Map();
  const rows = Array.isArray(models) ? models : [];

  for (const model of rows) {
    let modelId = null;
    try {
      modelId = toBigIntString(model?.modelId);
    } catch (_error) {
      continue;
    }
    if (!modelId) continue;
    byModelId.set(modelId, {
      ...model,
      modelId,
    });
  }

  return Array.from(byModelId.values());
}

async function findShopByShopeeShopId(shopeeShopId) {
  const row = await queryOne(
    `
      SELECT id, "shopId" AS shop_id
      FROM "Shop"
      WHERE "shopId" = $1::bigint
      LIMIT 1
    `,
    [toBigIntString(shopeeShopId)],
  );

  return row
    ? {
        id: Number(row.id),
        shopId: row.shop_id == null ? null : BigInt(row.shop_id),
      }
    : null;
}

async function ensureProductSyncStateTable() {
  if (ensureProductSyncStatePromise) {
    return ensureProductSyncStatePromise;
  }

  ensureProductSyncStatePromise = query(`
    CREATE TABLE IF NOT EXISTS "ProductSyncState" (
      "shopId" INTEGER NOT NULL,
      "runCount" INTEGER NOT NULL DEFAULT 0,
      "lastSyncedAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ProductSyncState_pkey" PRIMARY KEY ("shopId")
    )
  `).catch((error) => {
    ensureProductSyncStatePromise = null;
    throw error;
  });

  return ensureProductSyncStatePromise;
}

async function bumpProductSyncRun(shopId) {
  await ensureProductSyncStateTable();

  const row = await queryOne(
    `
      INSERT INTO "ProductSyncState" (
        "shopId",
        "runCount",
        "lastSyncedAt",
        "createdAt",
        "updatedAt"
      )
      VALUES ($1, 1, NOW(), NOW(), NOW())
      ON CONFLICT ("shopId")
      DO UPDATE SET
        "runCount" = "ProductSyncState"."runCount" + 1,
        "lastSyncedAt" = NOW(),
        "updatedAt" = NOW()
      RETURNING "runCount", "lastSyncedAt"
    `,
    [Number(shopId)],
  );

  return {
    runCount: Number(row?.runCount || 1),
    lastSyncedAt: row?.lastSyncedAt || null,
  };
}

async function listExistingProductRatings(shopId, itemIds = []) {
  const normalizedItemIds = (Array.isArray(itemIds) ? itemIds : [])
    .map((value) => {
      try {
        return toBigIntString(value);
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);

  if (!normalizedItemIds.length) {
    return [];
  }

  const result = await query(
    `
      SELECT
        id,
        "itemId" AS item_id,
        "priceMin" AS price_min,
        "priceMax" AS price_max,
        stock,
        sold,
        "hasModel" AS has_model,
        "ratingStar" AS rating_star,
        "ratingCount" AS rating_count,
        "ratingOver500" AS rating_over_500,
        "ratingSyncedAt" AS rating_synced_at
      FROM "Product"
      WHERE "shopId" = $1
        AND "itemId" = ANY($2::bigint[])
    `,
    [Number(shopId), normalizedItemIds],
  );

  return result.rows.map((row) => ({
    id: row.id == null ? null : Number(row.id),
    itemId: row.item_id == null ? null : BigInt(row.item_id),
    priceMin: row.price_min == null ? null : Number(row.price_min),
    priceMax: row.price_max == null ? null : Number(row.price_max),
    stock: row.stock == null ? null : Number(row.stock),
    sold: row.sold == null ? null : Number(row.sold),
    hasModel: row.has_model == null ? null : Boolean(row.has_model),
    ratingStar: row.rating_star == null ? null : Number(row.rating_star),
    ratingCount: row.rating_count == null ? null : Number(row.rating_count),
    ratingOver500: Boolean(row.rating_over_500),
    ratingSyncedAt: row.rating_synced_at || null,
  }));
}

async function upsertProductForSync(shopId, payload) {
  const valuesWithGtin = [
    Number(shopId),
    toBigIntString(payload.itemId),
    payload.status || null,
    payload.title || null,
    payload.description || null,
    payload.ratingStar,
    toIntOrNull(payload.ratingCount),
    Boolean(payload.ratingOver500),
    payload.ratingSyncedAt || null,
    payload.currency || null,
    toMoneyOrNull(payload.priceMin),
    toMoneyOrNull(payload.priceMax),
    payload.itemSku || null,
    payload.gtinCode || null,
    toIntOrNull(payload.stock),
    toIntOrNull(payload.sold),
    JSON.stringify(payload.attributes ?? null),
    JSON.stringify(payload.logistics ?? null),
    JSON.stringify(payload.dimension ?? null),
    payload.weight,
    payload.shippingModeCache || null,
    Boolean(payload.spxEnabledCache),
    Boolean(payload.spxLogisticsEligibleCache),
    Boolean(payload.spxPhysicalEligibleCache),
    Boolean(payload.spxEligibleCache),
    JSON.stringify(payload.spxEligibilityReasonsCache ?? null),
    payload.spxSnapshotAt || null,
    toIntOrNull(payload.daysToShip),
    payload.hasModel,
    payload.brand || null,
    payload.categoryId == null ? null : toBigIntString(payload.categoryId),
    payload.shopeeCreateTime || null,
    payload.shopeeUpdateTime || null,
    Boolean(payload.shouldUpdateRatingSyncedAt),
    Boolean(payload.shouldUpdatePrice),
    Boolean(payload.shouldUpdateStock),
    payload.shouldUpdateSold !== false,
  ];

  const queryWithGtin = `
    INSERT INTO "Product" (
      "shopId",
      "itemId",
      status,
      title,
      description,
      "ratingStar",
      "ratingCount",
      "ratingOver500",
      "ratingSyncedAt",
      currency,
      "priceMin",
      "priceMax",
      "itemSku",
      "gtinCode",
      stock,
      sold,
      attributes,
      logistics,
      dimension,
      weight,
      "shippingModeCache",
      "spxEnabledCache",
      "spxLogisticsEligibleCache",
      "spxPhysicalEligibleCache",
      "spxEligibleCache",
      "spxEligibilityReasonsCache",
      "spxSnapshotAt",
      "daysToShip",
      "hasModel",
      brand,
      "categoryId",
      "shopeeCreateTime",
      "shopeeUpdateTime",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      $1, $2::bigint, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
      $17::jsonb, $18::jsonb, $19::jsonb, $20, $21, $22, $23, $24, $25, $26::jsonb,
      $27, $28, $29, $30, $31::bigint, $32, $33, NOW(), NOW()
    )
    ON CONFLICT ("shopId", "itemId")
    DO UPDATE SET
      status = EXCLUDED.status,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      "ratingStar" = EXCLUDED."ratingStar",
      "ratingCount" = EXCLUDED."ratingCount",
      "ratingOver500" = EXCLUDED."ratingOver500",
      "ratingSyncedAt" = CASE
        WHEN $34::boolean THEN EXCLUDED."ratingSyncedAt"
        ELSE "Product"."ratingSyncedAt"
      END,
      currency = EXCLUDED.currency,
      "priceMin" = CASE
        WHEN $35::boolean THEN EXCLUDED."priceMin"
        ELSE "Product"."priceMin"
      END,
      "priceMax" = CASE
        WHEN $35::boolean THEN EXCLUDED."priceMax"
        ELSE "Product"."priceMax"
      END,
      "itemSku" = EXCLUDED."itemSku",
      "gtinCode" = EXCLUDED."gtinCode",
      stock = CASE
        WHEN $36::boolean THEN EXCLUDED.stock
        ELSE "Product".stock
      END,
      sold = CASE
        WHEN $37::boolean THEN EXCLUDED.sold
        ELSE "Product".sold
      END,
      attributes = EXCLUDED.attributes,
      logistics = EXCLUDED.logistics,
      dimension = EXCLUDED.dimension,
      weight = EXCLUDED.weight,
      "shippingModeCache" = EXCLUDED."shippingModeCache",
      "spxEnabledCache" = EXCLUDED."spxEnabledCache",
      "spxLogisticsEligibleCache" = EXCLUDED."spxLogisticsEligibleCache",
      "spxPhysicalEligibleCache" = EXCLUDED."spxPhysicalEligibleCache",
      "spxEligibleCache" = EXCLUDED."spxEligibleCache",
      "spxEligibilityReasonsCache" = EXCLUDED."spxEligibilityReasonsCache",
      "spxSnapshotAt" = EXCLUDED."spxSnapshotAt",
      "daysToShip" = EXCLUDED."daysToShip",
      "hasModel" = EXCLUDED."hasModel",
      brand = EXCLUDED.brand,
      "categoryId" = EXCLUDED."categoryId",
      "shopeeCreateTime" = EXCLUDED."shopeeCreateTime",
      "shopeeUpdateTime" = EXCLUDED."shopeeUpdateTime",
      "updatedAt" = NOW()
    RETURNING id
  `;

  const valuesWithoutGtin = [
    Number(shopId),
    toBigIntString(payload.itemId),
    payload.status || null,
    payload.title || null,
    payload.description || null,
    payload.ratingStar,
    toIntOrNull(payload.ratingCount),
    Boolean(payload.ratingOver500),
    payload.ratingSyncedAt || null,
    payload.currency || null,
    toMoneyOrNull(payload.priceMin),
    toMoneyOrNull(payload.priceMax),
    payload.itemSku || null,
    toIntOrNull(payload.stock),
    toIntOrNull(payload.sold),
    JSON.stringify(payload.attributes ?? null),
    JSON.stringify(payload.logistics ?? null),
    JSON.stringify(payload.dimension ?? null),
    payload.weight,
    payload.shippingModeCache || null,
    Boolean(payload.spxEnabledCache),
    Boolean(payload.spxLogisticsEligibleCache),
    Boolean(payload.spxPhysicalEligibleCache),
    Boolean(payload.spxEligibleCache),
    JSON.stringify(payload.spxEligibilityReasonsCache ?? null),
    payload.spxSnapshotAt || null,
    toIntOrNull(payload.daysToShip),
    payload.hasModel,
    payload.brand || null,
    payload.categoryId == null ? null : toBigIntString(payload.categoryId),
    payload.shopeeCreateTime || null,
    payload.shopeeUpdateTime || null,
    Boolean(payload.shouldUpdateRatingSyncedAt),
    Boolean(payload.shouldUpdatePrice),
    Boolean(payload.shouldUpdateStock),
    payload.shouldUpdateSold !== false,
  ];

  const queryWithoutGtin = `
    INSERT INTO "Product" (
      "shopId",
      "itemId",
      status,
      title,
      description,
      "ratingStar",
      "ratingCount",
      "ratingOver500",
      "ratingSyncedAt",
      currency,
      "priceMin",
      "priceMax",
      "itemSku",
      stock,
      sold,
      attributes,
      logistics,
      dimension,
      weight,
      "shippingModeCache",
      "spxEnabledCache",
      "spxLogisticsEligibleCache",
      "spxPhysicalEligibleCache",
      "spxEligibleCache",
      "spxEligibilityReasonsCache",
      "spxSnapshotAt",
      "daysToShip",
      "hasModel",
      brand,
      "categoryId",
      "shopeeCreateTime",
      "shopeeUpdateTime",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      $1, $2::bigint, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
      $16::jsonb, $17::jsonb, $18::jsonb, $19, $20, $21, $22, $23, $24, $25::jsonb,
      $26, $27, $28, $29, $30::bigint, $31, $32, NOW(), NOW()
    )
    ON CONFLICT ("shopId", "itemId")
    DO UPDATE SET
      status = EXCLUDED.status,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      "ratingStar" = EXCLUDED."ratingStar",
      "ratingCount" = EXCLUDED."ratingCount",
      "ratingOver500" = EXCLUDED."ratingOver500",
      "ratingSyncedAt" = CASE
        WHEN $33::boolean THEN EXCLUDED."ratingSyncedAt"
        ELSE "Product"."ratingSyncedAt"
      END,
      currency = EXCLUDED.currency,
      "priceMin" = CASE
        WHEN $34::boolean THEN EXCLUDED."priceMin"
        ELSE "Product"."priceMin"
      END,
      "priceMax" = CASE
        WHEN $34::boolean THEN EXCLUDED."priceMax"
        ELSE "Product"."priceMax"
      END,
      "itemSku" = EXCLUDED."itemSku",
      stock = CASE
        WHEN $35::boolean THEN EXCLUDED.stock
        ELSE "Product".stock
      END,
      sold = CASE
        WHEN $36::boolean THEN EXCLUDED.sold
        ELSE "Product".sold
      END,
      attributes = EXCLUDED.attributes,
      logistics = EXCLUDED.logistics,
      dimension = EXCLUDED.dimension,
      weight = EXCLUDED.weight,
      "shippingModeCache" = EXCLUDED."shippingModeCache",
      "spxEnabledCache" = EXCLUDED."spxEnabledCache",
      "spxLogisticsEligibleCache" = EXCLUDED."spxLogisticsEligibleCache",
      "spxPhysicalEligibleCache" = EXCLUDED."spxPhysicalEligibleCache",
      "spxEligibleCache" = EXCLUDED."spxEligibleCache",
      "spxEligibilityReasonsCache" = EXCLUDED."spxEligibilityReasonsCache",
      "spxSnapshotAt" = EXCLUDED."spxSnapshotAt",
      "daysToShip" = EXCLUDED."daysToShip",
      "hasModel" = EXCLUDED."hasModel",
      brand = EXCLUDED.brand,
      "categoryId" = EXCLUDED."categoryId",
      "shopeeCreateTime" = EXCLUDED."shopeeCreateTime",
      "shopeeUpdateTime" = EXCLUDED."shopeeUpdateTime",
      "updatedAt" = NOW()
    RETURNING id
  `;

  let row;
  try {
    row = await queryOne(queryWithGtin, valuesWithGtin);
  } catch (error) {
    if (!isMissingGtinColumnError(error)) {
      throw error;
    }
    row = await queryOne(queryWithoutGtin, valuesWithoutGtin);
  }

  return row ? { id: Number(row.id) } : null;
}

async function replaceProductImages(productId, imageUrls = []) {
  return withClient(async (client) => {
    await client.query("BEGIN");

    try {
      await client.query(
        `
          DELETE FROM "ProductImage"
          WHERE "productId" = $1
        `,
        [Number(productId)],
      );

      const rows = (Array.isArray(imageUrls) ? imageUrls : []).filter(Boolean);
      if (rows.length) {
        const values = [];
        const tuples = rows.map((url) => {
          values.push(Number(productId), String(url));
          const start = values.length - 1;
          return `($${start}, $${start + 1})`;
        });

        await client.query(
          `
            INSERT INTO "ProductImage" ("productId", url)
            VALUES ${tuples.join(", ")}
          `,
          values,
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

async function replaceProductModels(productId, models = []) {
  return withClient(async (client) => {
    await client.query("BEGIN");

    try {
      await client.query(
        `
          DELETE FROM "ProductModel"
          WHERE "productId" = $1
        `,
        [Number(productId)],
      );

      const rows = normalizeProductModels(models);
      if (rows.length) {
        const valuesWithGtin = [];
        const tuplesWithGtin = rows.map((model) => {
          valuesWithGtin.push(
            Number(productId),
            toBigIntString(model.modelId),
            model.name || null,
            model.sku || null,
            model.gtinCode || null,
            toMoneyOrNull(model.price),
            toIntOrNull(model.stock),
            toIntOrNull(model.sold),
          );
          const base = valuesWithGtin.length - 7;
          return `($${base}, $${base + 1}::bigint, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
        });

        const insertWithGtinQuery = `
          INSERT INTO "ProductModel" (
            "productId",
            "modelId",
            name,
            sku,
            "gtinCode",
            price,
            stock,
            sold
          )
          VALUES ${tuplesWithGtin.join(", ")}
          ON CONFLICT ("productId", "modelId")
          DO UPDATE SET
            name = EXCLUDED.name,
            sku = EXCLUDED.sku,
            "gtinCode" = EXCLUDED."gtinCode",
            price = EXCLUDED.price,
            stock = EXCLUDED.stock,
            sold = EXCLUDED.sold
        `;

        try {
          await client.query("SAVEPOINT product_model_insert_gtin");
          await client.query(insertWithGtinQuery, valuesWithGtin);
          await client.query("RELEASE SAVEPOINT product_model_insert_gtin");
        } catch (error) {
          await client.query(
            "ROLLBACK TO SAVEPOINT product_model_insert_gtin",
          );
          await client.query("RELEASE SAVEPOINT product_model_insert_gtin");
          if (!isMissingGtinColumnError(error)) {
            throw error;
          }

          const valuesWithoutGtin = [];
          const tuplesWithoutGtin = rows.map((model) => {
            valuesWithoutGtin.push(
              Number(productId),
              toBigIntString(model.modelId),
              model.name || null,
              model.sku || null,
              toMoneyOrNull(model.price),
              toIntOrNull(model.stock),
              toIntOrNull(model.sold),
            );
            const base = valuesWithoutGtin.length - 6;
            return `($${base}, $${base + 1}::bigint, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
          });

          await client.query(
            `
              INSERT INTO "ProductModel" (
                "productId",
                "modelId",
                name,
                sku,
                price,
                stock,
                sold
              )
              VALUES ${tuplesWithoutGtin.join(", ")}
              ON CONFLICT ("productId", "modelId")
              DO UPDATE SET
                name = EXCLUDED.name,
                sku = EXCLUDED.sku,
                price = EXCLUDED.price,
                stock = EXCLUDED.stock,
                sold = EXCLUDED.sold
            `,
            valuesWithoutGtin,
          );
        }
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

async function upsertProductModelsForSync(productId, models = [], options = {}) {
  const rows = normalizeProductModels(models);
  if (!rows.length) return;

  const shouldUpdatePrice = Boolean(options.shouldUpdatePrice);
  const shouldUpdateStock = Boolean(options.shouldUpdateStock);
  const shouldUpdateSold = options.shouldUpdateSold !== false;

  const valuesWithGtin = [];
  const tuplesWithGtin = rows.map((model) => {
    valuesWithGtin.push(
      Number(productId),
      toBigIntString(model.modelId),
      model.name || null,
      model.sku || null,
      model.gtinCode || null,
      toMoneyOrNull(model.price),
      toIntOrNull(model.stock),
      toIntOrNull(model.sold),
    );
    const base = valuesWithGtin.length - 7;
    return `($${base}, $${base + 1}::bigint, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
  });
  const priceFlagGtin = valuesWithGtin.length + 1;
  const stockFlagGtin = valuesWithGtin.length + 2;
  const soldFlagGtin = valuesWithGtin.length + 3;

  try {
    await query(
      `
        INSERT INTO "ProductModel" (
          "productId",
          "modelId",
          name,
          sku,
          "gtinCode",
          price,
          stock,
          sold
        )
        VALUES ${tuplesWithGtin.join(", ")}
        ON CONFLICT ("productId", "modelId")
        DO UPDATE SET
          name = EXCLUDED.name,
          sku = EXCLUDED.sku,
          "gtinCode" = EXCLUDED."gtinCode",
          price = CASE
            WHEN $${priceFlagGtin}::boolean THEN EXCLUDED.price
            ELSE "ProductModel".price
          END,
          stock = CASE
            WHEN $${stockFlagGtin}::boolean THEN EXCLUDED.stock
            ELSE "ProductModel".stock
          END,
          sold = CASE
            WHEN $${soldFlagGtin}::boolean THEN EXCLUDED.sold
            ELSE "ProductModel".sold
          END
      `,
      [
        ...valuesWithGtin,
        shouldUpdatePrice,
        shouldUpdateStock,
        shouldUpdateSold,
      ],
    );
    return;
  } catch (error) {
    if (!isMissingGtinColumnError(error)) {
      throw error;
    }
  }

  const valuesWithoutGtin = [];
  const tuplesWithoutGtin = rows.map((model) => {
    valuesWithoutGtin.push(
      Number(productId),
      toBigIntString(model.modelId),
      model.name || null,
      model.sku || null,
      toMoneyOrNull(model.price),
      toIntOrNull(model.stock),
      toIntOrNull(model.sold),
    );
    const base = valuesWithoutGtin.length - 6;
    return `($${base}, $${base + 1}::bigint, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
  });
  const priceFlag = valuesWithoutGtin.length + 1;
  const stockFlag = valuesWithoutGtin.length + 2;
  const soldFlag = valuesWithoutGtin.length + 3;

  await query(
    `
      INSERT INTO "ProductModel" (
        "productId",
        "modelId",
        name,
        sku,
        price,
        stock,
        sold
      )
      VALUES ${tuplesWithoutGtin.join(", ")}
      ON CONFLICT ("productId", "modelId")
      DO UPDATE SET
        name = EXCLUDED.name,
        sku = EXCLUDED.sku,
        price = CASE
          WHEN $${priceFlag}::boolean THEN EXCLUDED.price
          ELSE "ProductModel".price
        END,
        stock = CASE
          WHEN $${stockFlag}::boolean THEN EXCLUDED.stock
          ELSE "ProductModel".stock
        END,
        sold = CASE
          WHEN $${soldFlag}::boolean THEN EXCLUDED.sold
          ELSE "ProductModel".sold
        END
    `,
    [
      ...valuesWithoutGtin,
      shouldUpdatePrice,
      shouldUpdateStock,
      shouldUpdateSold,
    ],
  );
}

module.exports = {
  bumpProductSyncRun,
  findShopByShopeeShopId,
  listExistingProductRatings,
  replaceProductImages,
  replaceProductModels,
  upsertProductForSync,
  upsertProductModelsForSync,
  _test: {
    toMoneyOrNull,
  },
};
