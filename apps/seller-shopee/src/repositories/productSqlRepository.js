"use strict";

const { query, queryOne, withClient } = require("../config/postgres");
const SALES_EXCLUDED_STATUSES = ["CANCELLED", "UNPAID", "TO_RETURN", "IN_CANCEL"];
const ACTIVE_PRODUCT_STATUSES = ["NORMAL", "ACTIVE"];

function toBigIntOrNull(value) {
  if (value == null || value === "") {
    return null;
  }

  try {
    return BigInt(value);
  } catch (_error) {
    return null;
  }
}

function toNumberOrNull(value) {
  if (value == null || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeItemId(value) {
  if (value == null || value === "") {
    return null;
  }

  try {
    return BigInt(value).toString();
  } catch (_error) {
    return null;
  }
}

function normalizeItemIds(itemIds = []) {
  return Array.from(
    new Set(
      itemIds
        .map(normalizeItemId)
        .filter(Boolean),
    ),
  );
}

function pushActiveProductStatusClause({
  clauses,
  params,
  alias = "p",
  includeInactive = false,
}) {
  if (includeInactive) return;
  params.push(ACTIVE_PRODUCT_STATUSES);
  clauses.push(
    `UPPER(TRIM(COALESCE(${alias}.status, ''))) = ANY($${params.length}::text[])`,
  );
}

function normalizeStatusFilters(rawStatuses = []) {
  const list = Array.isArray(rawStatuses) ? rawStatuses : [rawStatuses];
  return Array.from(
    new Set(
      list
        .map((value) =>
          String(value || "")
            .trim()
            .toUpperCase(),
        )
        .filter((value) => value && value !== "ALL" && value !== "TODOS"),
    ),
  );
}

function normalizeSkuFilters(rawSkus = []) {
  const list = Array.isArray(rawSkus) ? rawSkus : [rawSkus];
  return Array.from(
    new Set(
      list
        .map((value) =>
          String(value || "")
            .trim()
            .toUpperCase(),
        )
        .filter(Boolean),
    ),
  );
}

function mapImageRow(row) {
  return {
    id: Number(row.id),
    productId: Number(row.productId),
    url: row.url,
    imageId: row.imageId || null,
  };
}

function mapModelRow(row) {
  return {
    id: Number(row.id),
    productId: Number(row.productId),
    modelId: toBigIntOrNull(row.modelId),
    name: row.name || null,
    sku: row.sku || null,
    price: toNumberOrNull(row.price),
    stock: toNumberOrNull(row.stock),
    sold: toNumberOrNull(row.sold),
    ratingStar: row.ratingStar == null ? null : Number(row.ratingStar),
    ratingCount: toNumberOrNull(row.ratingCount),
    shopeeCreateTime: row.shopeeCreateTime || null,
  };
}

function mapProductRow(row) {
  return {
    id: Number(row.id),
    shopId: Number(row.shopId),
    itemId: toBigIntOrNull(row.itemId),
    status: row.status || null,
    title: row.title || null,
    description: row.description || null,
    ratingStar: row.ratingStar == null ? null : Number(row.ratingStar),
    ratingCount: toNumberOrNull(row.ratingCount),
    ratingOver500: Boolean(row.ratingOver500),
    ratingSyncedAt: row.ratingSyncedAt || null,
    costCents: toNumberOrNull(row.costCents) || 0,
    currency: row.currency || null,
    priceMin: toNumberOrNull(row.priceMin),
    priceMax: toNumberOrNull(row.priceMax),
    itemSku: row.itemSku || null,
    stock: toNumberOrNull(row.stock),
    sold: toNumberOrNull(row.sold),
    attributes: row.attributes || null,
    logistics: row.logistics || null,
    dimension: row.dimension || null,
    weight: row.weight == null ? null : Number(row.weight),
    shippingModeCache: row.shippingModeCache || null,
    spxEnabledCache: Boolean(row.spxEnabledCache),
    spxLogisticsEligibleCache: Boolean(row.spxLogisticsEligibleCache),
    spxPhysicalEligibleCache: Boolean(row.spxPhysicalEligibleCache),
    spxEligibleCache: Boolean(row.spxEligibleCache),
    spxEligibilityReasonsCache: Array.isArray(row.spxEligibilityReasonsCache)
      ? row.spxEligibilityReasonsCache
      : null,
    spxSnapshotAt: row.spxSnapshotAt || null,
    daysToShip: toNumberOrNull(row.daysToShip),
    hasModel: row.hasModel == null ? null : Boolean(row.hasModel),
    brand: row.brand || null,
    categoryId: toBigIntOrNull(row.categoryId),
    shopeeCreateTime: row.shopeeCreateTime || null,
    shopeeUpdateTime: row.shopeeUpdateTime || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapProductSalesSnapshotRow(row) {
  const hasModel = row.hasModel == null ? null : Boolean(row.hasModel);
  const modelsStock = toNumberOrNull(row.modelsStock) || 0;
  const baseStock = toNumberOrNull(row.stock);
  const totalStock = hasModel ? modelsStock : baseStock;

  return {
    id: Number(row.id),
    itemId: toBigIntOrNull(row.itemId),
    categoryId: toBigIntOrNull(row.categoryId),
    status: row.status || null,
    title: row.title || null,
    itemSku: row.itemSku || null,
    ratingStar: row.ratingStar == null ? null : Number(row.ratingStar),
    ratingCount: toNumberOrNull(row.ratingCount),
    stock: totalStock,
    hasModel,
    modelsStock,
    createdAt: row.createdAt || null,
    shopeeCreateTime: row.shopeeCreateTime || null,
    lastSaleAt: row.lastSaleAt || null,
    quantity: toNumberOrNull(row.quantity) || 0,
    orders: toNumberOrNull(row.orders) || 0,
    revenueCents: toNumberOrNull(row.revenueCents) || 0,
    brand: row.brand || null,
    images: row.imageUrl ? [{ url: row.imageUrl }] : [],
    attributes: row.attributes || null,
  };
}

function buildCatalogSearchClause(shopId, q, params, { includeInactive = false } = {}) {
  params.push(Number(shopId));
  const clauses = [`p."shopId" = $${params.length}`];
  pushActiveProductStatusClause({
    clauses,
    params,
    alias: "p",
    includeInactive,
  });

  const queryText = String(q || "").trim();
  if (queryText) {
    const itemId = normalizeItemId(queryText);
    const searchClauses = [];

    if (itemId) {
      params.push(itemId);
      searchClauses.push(`p."itemId" = $${params.length}::bigint`);
    }

    params.push(`%${queryText}%`);
    const ilikeParam = `$${params.length}`;
    searchClauses.push(`p.title ILIKE ${ilikeParam}`);
    searchClauses.push(`p.brand ILIKE ${ilikeParam}`);

    clauses.push(`(${searchClauses.join(" OR ")})`);
  }

  return clauses.join("\n        AND ");
}

async function countCatalogProducts(shopId, q, { includeInactive = false } = {}) {
  const params = [];
  const whereSql = buildCatalogSearchClause(shopId, q, params, {
    includeInactive,
  });
  const row = await queryOne(
    `
      SELECT COUNT(*)::int AS total
      FROM "Product" p
      WHERE ${whereSql}
    `,
    params,
  );

  return Number(row?.total || 0);
}

async function listCatalogProducts(
  shopId,
  { q, skip = 0, take = 24, includeInactive = false } = {},
) {
  const params = [];
  const whereSql = buildCatalogSearchClause(shopId, q, params, {
    includeInactive,
  });

  params.push(Number(skip));
  const skipParam = `$${params.length}`;
  params.push(Number(take));
  const takeParam = `$${params.length}`;

  const result = await query(
    `
      SELECT
        p.id,
        p."shopId",
        p."itemId",
        p.title,
        p.brand,
        p.attributes,
        p."updatedAt",
        COALESCE(
          (
            SELECT json_agg(
              json_build_object('url', pi.url)
              ORDER BY pi.id ASC
            )
            FROM (
              SELECT id, url
              FROM "ProductImage"
              WHERE "productId" = p.id
              ORDER BY id ASC
              LIMIT 10
            ) pi
          ),
          '[]'::json
        ) AS images
      FROM "Product" p
      WHERE ${whereSql}
      ORDER BY p."updatedAt" DESC NULLS LAST, p.id DESC
      OFFSET ${skipParam}
      LIMIT ${takeParam}
    `,
    params,
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    shopId: Number(row.shopId),
    itemId: toBigIntOrNull(row.itemId),
    title: row.title || null,
    brand: row.brand || null,
    attributes: row.attributes || null,
    updatedAt: row.updatedAt,
    images: Array.isArray(row.images) ? row.images : [],
  }));
}

async function findProductDetailByShopAndItemId(shopId, itemId) {
  const normalizedItemId = normalizeItemId(itemId);
  if (!normalizedItemId) {
    return null;
  }

  const row = await queryOne(
    `
      SELECT *
      FROM "Product"
      WHERE "shopId" = $1
        AND "itemId" = $2::bigint
      LIMIT 1
    `,
    [Number(shopId), normalizedItemId],
  );

  if (!row) {
    return null;
  }

  const product = mapProductRow(row);
  const [imagesResult, modelsResult] = await Promise.all([
    query(
      `
        SELECT *
        FROM "ProductImage"
        WHERE "productId" = $1
        ORDER BY id ASC
      `,
      [product.id],
    ),
    query(
      `
        SELECT *
        FROM "ProductModel"
        WHERE "productId" = $1
        ORDER BY "modelId" ASC, id ASC
      `,
      [product.id],
    ),
  ]);

  return {
    ...product,
    images: imagesResult.rows.map(mapImageRow),
    models: modelsResult.rows.map(mapModelRow),
  };
}

async function updateProductByShopAndItemId(shopId, itemId, data = {}) {
  const normalizedItemId = normalizeItemId(itemId);
  if (!normalizedItemId) {
    return false;
  }

  const params = [Number(shopId), normalizedItemId];
  const sets = [];
  let nextParam = 3;

  if (Object.prototype.hasOwnProperty.call(data, "title")) {
    sets.push(`title = $${nextParam++}`);
    params.push(data.title);
  }

  if (Object.prototype.hasOwnProperty.call(data, "description")) {
    sets.push(`description = $${nextParam++}`);
    params.push(data.description);
  }

  if (Object.prototype.hasOwnProperty.call(data, "brand")) {
    sets.push(`brand = $${nextParam++}`);
    params.push(data.brand);
  }

  if (Object.prototype.hasOwnProperty.call(data, "categoryId")) {
    const normalizedCategoryId = normalizeItemId(data.categoryId);
    sets.push(`"categoryId" = $${nextParam++}::bigint`);
    params.push(normalizedCategoryId);
  }

  if (Object.prototype.hasOwnProperty.call(data, "attributes")) {
    sets.push(`attributes = $${nextParam++}::jsonb`);
    params.push(JSON.stringify(data.attributes || []));
  }

  if (Object.prototype.hasOwnProperty.call(data, "logistics")) {
    sets.push(`logistics = $${nextParam++}::jsonb`);
    params.push(JSON.stringify(data.logistics || []));
  }

  if (Object.prototype.hasOwnProperty.call(data, "shippingModeCache")) {
    sets.push(`"shippingModeCache" = $${nextParam++}`);
    params.push(data.shippingModeCache);
  }

  if (Object.prototype.hasOwnProperty.call(data, "spxEnabledCache")) {
    sets.push(`"spxEnabledCache" = $${nextParam++}`);
    params.push(Boolean(data.spxEnabledCache));
  }

  if (Object.prototype.hasOwnProperty.call(data, "spxLogisticsEligibleCache")) {
    sets.push(`"spxLogisticsEligibleCache" = $${nextParam++}`);
    params.push(Boolean(data.spxLogisticsEligibleCache));
  }

  if (Object.prototype.hasOwnProperty.call(data, "spxPhysicalEligibleCache")) {
    sets.push(`"spxPhysicalEligibleCache" = $${nextParam++}`);
    params.push(Boolean(data.spxPhysicalEligibleCache));
  }

  if (Object.prototype.hasOwnProperty.call(data, "spxEligibleCache")) {
    sets.push(`"spxEligibleCache" = $${nextParam++}`);
    params.push(Boolean(data.spxEligibleCache));
  }

  if (Object.prototype.hasOwnProperty.call(data, "spxEligibilityReasonsCache")) {
    sets.push(`"spxEligibilityReasonsCache" = $${nextParam++}::jsonb`);
    params.push(JSON.stringify(data.spxEligibilityReasonsCache || []));
  }

  if (Object.prototype.hasOwnProperty.call(data, "spxSnapshotAt")) {
    sets.push(`"spxSnapshotAt" = $${nextParam++}`);
    params.push(data.spxSnapshotAt);
  }

  if (Object.prototype.hasOwnProperty.call(data, "daysToShip")) {
    sets.push(`"daysToShip" = $${nextParam++}::int`);
    params.push(
      data.daysToShip == null || data.daysToShip === ""
        ? null
        : Number(data.daysToShip),
    );
  }

  if (!sets.length) {
    return false;
  }

  sets.push(`"updatedAt" = NOW()`);

  const row = await queryOne(
    `
      UPDATE "Product"
      SET ${sets.join(", ")}
      WHERE "shopId" = $1
        AND "itemId" = $2::bigint
      RETURNING id
    `,
    params,
  );

  return Boolean(row);
}

async function updateProductById(productId, data = {}) {
  const params = [Number(productId)];
  const sets = [];
  let nextParam = 2;

  if (Object.prototype.hasOwnProperty.call(data, "logistics")) {
    sets.push(`logistics = $${nextParam++}::jsonb`);
    params.push(JSON.stringify(data.logistics || []));
  }

  if (Object.prototype.hasOwnProperty.call(data, "shippingModeCache")) {
    sets.push(`"shippingModeCache" = $${nextParam++}`);
    params.push(data.shippingModeCache);
  }

  if (Object.prototype.hasOwnProperty.call(data, "spxEnabledCache")) {
    sets.push(`"spxEnabledCache" = $${nextParam++}`);
    params.push(Boolean(data.spxEnabledCache));
  }

  if (Object.prototype.hasOwnProperty.call(data, "spxLogisticsEligibleCache")) {
    sets.push(`"spxLogisticsEligibleCache" = $${nextParam++}`);
    params.push(Boolean(data.spxLogisticsEligibleCache));
  }

  if (Object.prototype.hasOwnProperty.call(data, "spxPhysicalEligibleCache")) {
    sets.push(`"spxPhysicalEligibleCache" = $${nextParam++}`);
    params.push(Boolean(data.spxPhysicalEligibleCache));
  }

  if (Object.prototype.hasOwnProperty.call(data, "spxEligibleCache")) {
    sets.push(`"spxEligibleCache" = $${nextParam++}`);
    params.push(Boolean(data.spxEligibleCache));
  }

  if (Object.prototype.hasOwnProperty.call(data, "spxEligibilityReasonsCache")) {
    sets.push(`"spxEligibilityReasonsCache" = $${nextParam++}::jsonb`);
    params.push(JSON.stringify(data.spxEligibilityReasonsCache || []));
  }

  if (Object.prototype.hasOwnProperty.call(data, "spxSnapshotAt")) {
    sets.push(`"spxSnapshotAt" = $${nextParam++}`);
    params.push(data.spxSnapshotAt);
  }

  if (!sets.length) {
    return false;
  }

  sets.push(`"updatedAt" = NOW()`);

  const row = await queryOne(
    `
      UPDATE "Product"
      SET ${sets.join(", ")}
      WHERE id = $1
      RETURNING id
    `,
    params,
  );

  return Boolean(row);
}

async function listProductsForLogistics(shopId) {
  const result = await query(
    `
      SELECT
        id,
        "itemId",
        title,
        status,
        logistics,
        dimension,
        weight,
        "shippingModeCache",
        "spxEnabledCache",
        "spxLogisticsEligibleCache",
        "spxPhysicalEligibleCache",
        "spxEligibleCache",
        "spxEligibilityReasonsCache",
        "spxSnapshotAt"
      FROM "Product"
      WHERE "shopId" = $1
        AND UPPER(TRIM(COALESCE(status, ''))) <> 'DELETED'
        AND UPPER(TRIM(COALESCE(status, ''))) = ANY($2::text[])
      ORDER BY "shopeeUpdateTime" DESC NULLS LAST, id DESC
    `,
    [Number(shopId), ACTIVE_PRODUCT_STATUSES],
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    itemId: toBigIntOrNull(row.itemId),
    title: row.title || null,
    status: row.status || null,
    logistics: row.logistics || null,
    dimension: row.dimension || null,
    weight: row.weight == null ? null : Number(row.weight),
    shippingModeCache: row.shippingModeCache || null,
    spxEnabledCache: Boolean(row.spxEnabledCache),
    spxLogisticsEligibleCache: Boolean(row.spxLogisticsEligibleCache),
    spxPhysicalEligibleCache: Boolean(row.spxPhysicalEligibleCache),
    spxEligibleCache: Boolean(row.spxEligibleCache),
    spxEligibilityReasonsCache: Array.isArray(row.spxEligibilityReasonsCache)
      ? row.spxEligibilityReasonsCache
      : null,
    spxSnapshotAt: row.spxSnapshotAt || null,
  }));
}

async function listProductsByShopAndItemIdsForLogistics(shopId, itemIds = []) {
  const normalizedItemIds = normalizeItemIds(itemIds);
  if (!normalizedItemIds.length) {
    return [];
  }

  const result = await query(
    `
      SELECT
        id,
        "itemId",
        title,
        status,
        logistics,
        dimension,
        weight
      FROM "Product"
      WHERE "shopId" = $1
        AND "itemId" = ANY($2::bigint[])
        AND UPPER(TRIM(COALESCE(status, ''))) <> 'DELETED'
        AND UPPER(TRIM(COALESCE(status, ''))) = ANY($3::text[])
      ORDER BY id ASC
    `,
    [Number(shopId), normalizedItemIds, ACTIVE_PRODUCT_STATUSES],
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    itemId: toBigIntOrNull(row.itemId),
    title: row.title || null,
    status: row.status || null,
    logistics: row.logistics || null,
    dimension: row.dimension || null,
    weight: row.weight == null ? null : Number(row.weight),
  }));
}

async function listProductsByShopAndItemIdsForLogisticsAnyStatus(shopId, itemIds = []) {
  const normalizedItemIds = normalizeItemIds(itemIds);
  if (!normalizedItemIds.length) {
    return [];
  }

  const result = await query(
    `
      SELECT
        id,
        "itemId",
        title,
        status,
        logistics,
        dimension,
        weight
      FROM "Product"
      WHERE "shopId" = $1
        AND "itemId" = ANY($2::bigint[])
        AND UPPER(TRIM(COALESCE(status, ''))) <> 'DELETED'
      ORDER BY id ASC
    `,
    [Number(shopId), normalizedItemIds],
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    itemId: toBigIntOrNull(row.itemId),
    title: row.title || null,
    status: row.status || null,
    logistics: row.logistics || null,
    dimension: row.dimension || null,
    weight: row.weight == null ? null : Number(row.weight),
  }));
}

async function listProductsByShopAndItemIdsForManagement(shopId, itemIds = []) {
  const normalizedItemIds = normalizeItemIds(itemIds);
  if (!normalizedItemIds.length) {
    return [];
  }

  const result = await query(
    `
      SELECT
        p."itemId",
        p.status,
        p.title,
        p."itemSku",
        p."daysToShip",
        p.logistics,
        p."updatedAt"
      FROM "Product" p
      WHERE p."shopId" = $1
        AND p."itemId" = ANY($2::bigint[])
        AND UPPER(TRIM(COALESCE(p.status, ''))) <> 'DELETED'
        AND UPPER(TRIM(COALESCE(p.status, ''))) = ANY($3::text[])
      ORDER BY p."updatedAt" DESC NULLS LAST, p.id DESC
    `,
    [Number(shopId), normalizedItemIds, ACTIVE_PRODUCT_STATUSES],
  );

  return result.rows.map((row) => ({
    itemId: toBigIntOrNull(row.itemId),
    status: row.status || null,
    title: row.title || null,
    itemSku: row.itemSku || null,
    daysToShip: toNumberOrNull(row.daysToShip),
    logistics: row.logistics || null,
    updatedAt: row.updatedAt || null,
  }));
}

function buildProductsListWhereClause(
  shopId,
  q,
  params,
  { includeInactive = false, statuses = [], skuList = [] } = {},
) {
  params.push(Number(shopId));
  const clauses = [`p."shopId" = $${params.length}`];
  const normalizedStatuses = normalizeStatusFilters(statuses);
  if (normalizedStatuses.length > 0) {
    params.push(normalizedStatuses);
    clauses.push(`UPPER(TRIM(COALESCE(p.status, ''))) = ANY($${params.length}::text[])`);
  } else {
    pushActiveProductStatusClause({
      clauses,
      params,
      alias: "p",
      includeInactive,
    });
  }

  const normalizedSkus = normalizeSkuFilters(skuList);
  if (normalizedSkus.length > 0) {
    params.push(normalizedSkus);
    const skuParam = `$${params.length}`;
    clauses.push(
      `(
        UPPER(TRIM(COALESCE(p."itemSku", ''))) = ANY(${skuParam}::text[])
        OR EXISTS (
          SELECT 1
          FROM "ProductModel" pm
          WHERE pm."productId" = p.id
            AND UPPER(TRIM(COALESCE(pm.sku, ''))) = ANY(${skuParam}::text[])
        )
      )`,
    );
  }

  const queryText = String(q || "").trim();
  if (!queryText) {
    return clauses.join("\n        AND ");
  }

  const itemIds = Array.from(
    new Set(
      queryText
        .split(",")
        .map((value) => normalizeItemId(value))
        .filter(Boolean),
    ),
  );
  const isItemIdList = queryText.includes(",")
    && itemIds.length > 0
    && queryText.split(",").every((value) => Boolean(normalizeItemId(value)));
  if (isItemIdList) {
    params.push(itemIds);
    clauses.push(`p."itemId" = ANY($${params.length}::bigint[])`);
    return clauses.join("\n        AND ");
  }

  const searchClauses = [];
  const normalizedItemId = normalizeItemId(queryText);
  if (normalizedItemId) {
    params.push(normalizedItemId);
    searchClauses.push(`p."itemId" = $${params.length}::bigint`);
  }

  params.push(`%${queryText}%`);
  const ilikeParam = `$${params.length}`;
  searchClauses.push(`COALESCE(p.title, '') ILIKE ${ilikeParam}`);
  searchClauses.push(`COALESCE(p."itemSku", '') ILIKE ${ilikeParam}`);
  searchClauses.push(
    `EXISTS (
      SELECT 1
      FROM "ProductModel" pm
      WHERE pm."productId" = p.id
        AND COALESCE(pm.sku, '') ILIKE ${ilikeParam}
    )`,
  );

  clauses.push(`(${searchClauses.join(" OR ")})`);
  return clauses.join("\n        AND ");
}

function resolveProductsOrderBy(sortBy, sortDir) {
  const direction = String(sortDir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

  switch (String(sortBy || "updatedAt")) {
    case "createdAt":
      return `p."createdAt" ${direction}, p.id DESC`;
    case "shopeeCreateTime":
      return `p."shopeeCreateTime" ${direction} NULLS LAST, p.id DESC`;
    case "sold":
      return `p.sold ${direction} NULLS LAST, p.id DESC`;
    case "ratingStar":
      return `p."ratingStar" ${direction} NULLS LAST, p.id DESC`;
    case "ratingCount":
      return `p."ratingCount" ${direction} NULLS LAST, p.id DESC`;
    case "updatedAt":
    default:
      return `p."updatedAt" ${direction}, p.id DESC`;
  }
}

async function countProductsForManagement(
  shopId,
  {
    q = "",
    includeInactive = false,
    statuses = [],
    skuList = [],
  } = {},
) {
  const params = [];
  const whereSql = buildProductsListWhereClause(shopId, q, params, {
    includeInactive,
    statuses,
    skuList,
  });

  const row = await queryOne(
    `
      SELECT COUNT(*)::int AS total
      FROM "Product" p
      WHERE ${whereSql}
    `,
    params,
  );

  return Number(row?.total || 0);
}

async function listProductsForManagement(
  shopId,
  {
    q = "",
    sortBy = "updatedAt",
    sortDir = "desc",
    skip = 0,
    take = 50,
    includeInactive = false,
    statuses = [],
    skuList = [],
  } = {},
) {
  const params = [];
  const whereSql = buildProductsListWhereClause(shopId, q, params, {
    includeInactive,
    statuses,
    skuList,
  });
  const orderBySql = resolveProductsOrderBy(sortBy, sortDir);

  params.push(Number(skip));
  const skipParam = `$${params.length}`;
  params.push(Number(take));
  const takeParam = `$${params.length}`;

  const result = await query(
    `
      SELECT
        p."itemId",
        p.status,
        p.title,
        p."itemSku",
        p."daysToShip",
        p.sold,
        p."ratingStar",
        p."ratingCount",
        p."ratingOver500",
        p."priceMin",
        p."priceMax",
        p.currency,
        p."hasModel",
        p.stock,
        p.logistics,
        p."createdAt",
        p."updatedAt",
        p."shopeeCreateTime",
        (
          SELECT COALESCE(SUM(pm.stock), 0)::int
          FROM "ProductModel" pm
          WHERE pm."productId" = p.id
        ) AS "modelsStock",
        (
          SELECT COALESCE(SUM(pm.sold), 0)::int
          FROM "ProductModel" pm
          WHERE pm."productId" = p.id
        ) AS "modelsSold",
        (
          SELECT MIN(pm.price)
          FROM "ProductModel" pm
          WHERE pm."productId" = p.id
            AND pm.price IS NOT NULL
        ) AS "modelPriceMin",
        (
          SELECT MAX(pm.price)
          FROM "ProductModel" pm
          WHERE pm."productId" = p.id
            AND pm.price IS NOT NULL
        ) AS "modelPriceMax",
        (
          SELECT COALESCE(
            json_agg(
              json_build_object('url', image_row.url)
              ORDER BY image_row.id ASC
            ),
            '[]'::json
          )
          FROM (
            SELECT id, url
            FROM "ProductImage"
            WHERE "productId" = p.id
            ORDER BY id ASC
            LIMIT 1
          ) image_row
        ) AS images
      FROM "Product" p
      WHERE ${whereSql}
      ORDER BY ${orderBySql}
      OFFSET ${skipParam}
      LIMIT ${takeParam}
    `,
    params,
  );

  return result.rows.map((row) => ({
    itemId: toBigIntOrNull(row.itemId),
    status: row.status || null,
    title: row.title || null,
    itemSku: row.itemSku || null,
    daysToShip: toNumberOrNull(row.daysToShip),
    sold: toNumberOrNull(row.sold),
    ratingStar: row.ratingStar == null ? null : Number(row.ratingStar),
    ratingCount: toNumberOrNull(row.ratingCount),
    ratingOver500: Boolean(row.ratingOver500),
    priceMin: toNumberOrNull(row.priceMin),
    priceMax: toNumberOrNull(row.priceMax),
    currency: row.currency || null,
    hasModel: row.hasModel == null ? null : Boolean(row.hasModel),
    stock: toNumberOrNull(row.stock),
    logistics: row.logistics || null,
    images: Array.isArray(row.images) ? row.images : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    shopeeCreateTime: row.shopeeCreateTime || null,
    modelsStock: toNumberOrNull(row.modelsStock) || 0,
    modelsSold: toNumberOrNull(row.modelsSold) || 0,
    modelPriceMin: toNumberOrNull(row.modelPriceMin),
    modelPriceMax: toNumberOrNull(row.modelPriceMax),
  }));
}

async function mapSoldQuantityByItemIds(shopId, itemIds = []) {
  const normalized = Array.from(
    new Set(
      (Array.isArray(itemIds) ? itemIds : [])
        .map((value) => normalizeItemId(value))
        .filter(Boolean),
    ),
  );

  if (!normalized.length) return new Map();

  const result = await query(
    `
      SELECT
        oi."itemId" AS "itemId",
        COALESCE(SUM(oi.quantity), 0)::int AS quantity
      FROM "OrderItem" oi
      INNER JOIN "Order" o
        ON o.id = oi."orderId"
        AND o."shopId" = oi."shopId"
      WHERE oi."shopId" = $1
        AND oi."itemId" = ANY($2::bigint[])
        AND o."orderStatus" IS NOT NULL
        AND o."orderStatus" <> ALL($3::text[])
      GROUP BY oi."itemId"
    `,
    [Number(shopId), normalized, SALES_EXCLUDED_STATUSES],
  );

  return new Map(
    result.rows.map((row) => [String(row.itemId), Number(row.quantity || 0)]),
  );
}

async function listProductsForManagementExport(
  shopId,
  {
    q = "",
    includeInactive = false,
    statuses = [],
    skuList = [],
  } = {},
) {
  const params = [];
  const whereSql = buildProductsListWhereClause(shopId, q, params, {
    includeInactive,
    statuses,
    skuList,
  });

  const result = await query(
    `
      SELECT
        p.id,
        p."itemId",
        p."categoryId",
        p.status,
        p.title,
        p.description,
        p."itemSku",
        p."priceMin",
        p."priceMax",
        p.dimension,
        p.weight,
        p.logistics,
        p.sold,
        p."ratingStar",
        p."ratingCount",
        (
          SELECT MIN(di."promotionPrice")
          FROM "DiscountItem" di
          INNER JOIN "DiscountCampaign" dc
            ON dc.id = di."campaignId"
          WHERE di."productId" = p.id
            AND di."promotionPrice" IS NOT NULL
            AND LOWER(TRIM(COALESCE(dc.status, ''))) = 'ongoing'
        ) AS "activePromotionPrice",
        p."hasModel",
        p.stock,
        (
          SELECT COALESCE(SUM(pm.stock), 0)::int
          FROM "ProductModel" pm
          WHERE pm."productId" = p.id
        ) AS "modelsStock",
        COALESCE(
          (
            SELECT json_agg(
              row_to_json(pm_row)
              ORDER BY pm_row."modelId" ASC, pm_row.id ASC
            )
            FROM (
              SELECT
                pm.*,
                (
                  SELECT MIN(di."modelPromotionPrice")
                  FROM "DiscountItem" di
                  INNER JOIN "DiscountCampaign" dc
                    ON dc.id = di."campaignId"
                  WHERE di."productId" = p.id
                    AND di."modelId" = pm."modelId"
                    AND di."modelPromotionPrice" IS NOT NULL
                    AND LOWER(TRIM(COALESCE(dc.status, ''))) = 'ongoing'
                ) AS "activeModelPromotionPrice"
              FROM "ProductModel" pm
              WHERE pm."productId" = p.id
            ) pm_row
          ),
          '[]'::json
        ) AS models
      FROM "Product" p
      WHERE ${whereSql}
      ORDER BY p."updatedAt" DESC, p.id DESC
    `,
    params,
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    itemId: toBigIntOrNull(row.itemId),
    status: row.status || null,
    title: row.title || null,
    description: row.description || null,
    itemSku: row.itemSku || null,
    priceMin: toNumberOrNull(row.priceMin),
    priceMax: toNumberOrNull(row.priceMax),
    dimension: row.dimension || null,
    weight: row.weight == null ? null : Number(row.weight),
    logistics: row.logistics || null,
    sold: toNumberOrNull(row.sold),
    ratingStar: row.ratingStar == null ? null : Number(row.ratingStar),
    ratingCount: toNumberOrNull(row.ratingCount),
    activePromotionPrice: toNumberOrNull(row.activePromotionPrice),
    hasModel: row.hasModel == null ? null : Boolean(row.hasModel),
    stock: toNumberOrNull(row.stock),
    modelsStock: toNumberOrNull(row.modelsStock) || 0,
    models: Array.isArray(row.models) ? row.models : [],
  }));
}

async function findProductIdByShopAndItemId(shopId, itemId) {
  const normalizedItemId = normalizeItemId(itemId);
  if (!normalizedItemId) {
    return null;
  }

  const row = await queryOne(
    `
      SELECT id
      FROM "Product"
      WHERE "shopId" = $1
        AND "itemId" = $2::bigint
      LIMIT 1
    `,
    [Number(shopId), normalizedItemId],
  );

  return row ? { id: Number(row.id) } : null;
}

async function listProductsByShopAndIdentifiers(
  shopId,
  { itemIds = [], skus = [] } = {},
) {
  const normalizedItemIds = normalizeItemIds(itemIds);
  const normalizedSkus = normalizeSkuFilters(skus);

  if (!normalizedItemIds.length && !normalizedSkus.length) {
    return [];
  }

  const result = await query(
    `
      SELECT DISTINCT ON (p."itemId")
        p.id,
        p."itemId",
        p.title,
        p.status,
        p."itemSku",
        CASE
          WHEN p."itemId" = ANY($2::bigint[]) THEN 'id'
          WHEN UPPER(TRIM(COALESCE(p."itemSku", ''))) = ANY($3::text[]) THEN 'sku_produto'
          ELSE 'sku_variacao'
        END AS "matchType",
        CASE
          WHEN UPPER(TRIM(COALESCE(p."itemSku", ''))) = ANY($3::text[])
            THEN NULLIF(p."itemSku", '')
          ELSE (
            SELECT NULLIF(pm.sku, '')
            FROM "ProductModel" pm
            WHERE pm."productId" = p.id
              AND UPPER(TRIM(COALESCE(pm.sku, ''))) = ANY($3::text[])
            ORDER BY pm.id ASC
            LIMIT 1
          )
        END AS "matchedSku"
      FROM "Product" p
      WHERE p."shopId" = $1
        AND UPPER(TRIM(COALESCE(p.status, ''))) <> 'DELETED'
        AND (
          p."itemId" = ANY($2::bigint[])
          OR UPPER(TRIM(COALESCE(p."itemSku", ''))) = ANY($3::text[])
          OR EXISTS (
            SELECT 1
            FROM "ProductModel" pm
            WHERE pm."productId" = p.id
              AND UPPER(TRIM(COALESCE(pm.sku, ''))) = ANY($3::text[])
          )
        )
      ORDER BY p."itemId", p.id ASC
    `,
    [Number(shopId), normalizedItemIds, normalizedSkus],
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    itemId: toBigIntOrNull(row.itemId),
    title: row.title || null,
    status: row.status || null,
    itemSku: row.itemSku || null,
    matchedSku: row.matchedSku || null,
    matchType: row.matchType || null,
  }));
}

async function replaceProductImages(productId, rows = []) {
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

      if (rows.length) {
        const values = [];
        const tuples = rows.map((row) => {
          values.push(Number(productId), row.url || "", row.imageId || null);
          const offset = values.length - 2;
          return `($${offset}, $${offset + 1}, $${offset + 2})`;
        });

        await client.query(
          `
            INSERT INTO "ProductImage" ("productId", url, "imageId")
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

async function listGroupedProductSalesSince(
  shopId,
  since,
  excludedProductIds = [],
) {
  const normalizedExcludedIds = (Array.isArray(excludedProductIds) ? excludedProductIds : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);

  const result = await query(
    `
      SELECT
        oi."productId" AS "productId",
        COALESCE(SUM(oi.quantity), 0)::int AS quantity
      FROM "OrderItem" oi
      INNER JOIN "Order" o ON o.id = oi."orderId"
      INNER JOIN "Product" p ON p.id = oi."productId"
      WHERE oi."shopId" = $1
        AND oi."productId" IS NOT NULL
        AND p."shopId" = $1
        AND o."shopeeCreateTime" >= $2
        AND NOT (oi."productId" = ANY($3::int[]))
      GROUP BY oi."productId"
    `,
    [Number(shopId), since, normalizedExcludedIds],
  );

  return result.rows.map((row) => ({
    productId: Number(row.productId),
    quantity: toNumberOrNull(row.quantity) || 0,
  }));
}

async function listVariationSalesByProductId(shopId, productId) {
  const result = await query(
    `
      SELECT
        oi."modelId" AS "modelId",
        COALESCE(NULLIF(MAX(oi."modelSku"), ''), NULL) AS "modelSku",
        COALESCE(SUM(oi.quantity), 0)::int AS quantity,
        COALESCE(
          SUM(
            CASE
              WHEN oi."dealPrice" IS NOT NULL
                THEN oi."dealPrice"::numeric * 100 * COALESCE(NULLIF(oi.quantity::text, '')::numeric, 1)
              WHEN oi."variationPrice" IS NOT NULL
                THEN oi."variationPrice"::numeric * 100 * COALESCE(NULLIF(oi.quantity::text, '')::numeric, 1)
              ELSE 0
            END
          ),
          0
        )::bigint AS "revenueCents"
      FROM "OrderItem" oi
      INNER JOIN "Order" o ON o.id = oi."orderId"
      WHERE oi."shopId" = $1
        AND oi."productId" = $2
        AND (
          o."orderStatus" IS NULL
          OR o."orderStatus" <> ALL($3::text[])
        )
      GROUP BY oi."modelId"
      ORDER BY oi."modelId" ASC NULLS LAST
    `,
    [Number(shopId), Number(productId), SALES_EXCLUDED_STATUSES],
  );

  return result.rows.map((row) => ({
    modelId: toBigIntOrNull(row.modelId),
    modelSku: row.modelSku || null,
    quantity: toNumberOrNull(row.quantity) || 0,
    revenueCents: toNumberOrNull(row.revenueCents) || 0,
  }));
}

async function listProductCardsByIds(shopId, productIds = []) {
  const normalizedIds = (Array.isArray(productIds) ? productIds : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);

  if (!normalizedIds.length) {
    return [];
  }

  const result = await query(
    `
      SELECT
        p.id,
        p."itemId",
        p.title,
        p."ratingStar",
        p."ratingCount",
        p.stock,
        (
          SELECT pi.url
          FROM "ProductImage" pi
          WHERE pi."productId" = p.id
          ORDER BY pi.id ASC
          LIMIT 1
        ) AS "imageUrl"
      FROM "Product" p
      WHERE p."shopId" = $1
        AND p.id = ANY($2::int[])
    `,
    [Number(shopId), normalizedIds],
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    itemId: toBigIntOrNull(row.itemId),
    title: row.title || null,
    ratingStar: row.ratingStar == null ? null : Number(row.ratingStar),
    ratingCount: toNumberOrNull(row.ratingCount),
    stock: toNumberOrNull(row.stock),
    images: row.imageUrl ? [{ url: row.imageUrl }] : [],
  }));
}

async function listProductsWithoutSalesSince(
  shopId,
  since,
  { includeInactive = false } = {},
) {
  const params = [Number(shopId), SALES_EXCLUDED_STATUSES];
  let salesDateClause = "";
  let productAgeClause = "";
  let activeStatusClause = "";

  if (since) {
    params.push(since);
    salesDateClause = `
            AND (
              (o."shopeeCreateTime" >= $3)
              OR (
                o."shopeeCreateTime" IS NULL
                AND o."createdAt" >= $3
              )
            )
    `;
    productAgeClause = `
        AND COALESCE(p."shopeeCreateTime", p."createdAt") <= $3
    `;
  }

  if (!includeInactive) {
    params.push(ACTIVE_PRODUCT_STATUSES);
    activeStatusClause = `
        AND UPPER(TRIM(COALESCE(p.status, ''))) = ANY($${params.length}::text[])
    `;
  }

  const result = await query(
    `
      SELECT
        p.id,
        p."itemId",
        p."categoryId",
        p.status,
        p.title,
        p."itemSku",
        p.sold,
        p."ratingStar",
        p."ratingCount",
        p."hasModel",
        p.stock,
        (
          SELECT COALESCE(SUM(pm.stock), 0)::int
          FROM "ProductModel" pm
          WHERE pm."productId" = p.id
        ) AS "modelsStock",
        p."priceMin",
        (
          SELECT pi.url
          FROM "ProductImage" pi
          WHERE pi."productId" = p.id
          ORDER BY pi.id ASC
          LIMIT 1
        ) AS "imageUrl"
      FROM "Product" p
      WHERE p."shopId" = $1
        ${productAgeClause}
        ${activeStatusClause}
        AND NOT EXISTS (
          SELECT 1
          FROM "OrderItem" oi
          INNER JOIN "Order" o ON o.id = oi."orderId"
          WHERE oi."productId" = p.id
            AND oi."shopId" = $1
            AND o."orderStatus" IS NOT NULL
            AND o."orderStatus" <> ALL($2::text[])
            ${salesDateClause}
        )
      ORDER BY p."updatedAt" DESC NULLS LAST, p.id DESC
    `,
    params,
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    itemId: toBigIntOrNull(row.itemId),
    status: row.status || null,
    title: row.title || null,
    itemSku: row.itemSku || null,
    sold: toNumberOrNull(row.sold),
    ratingStar: row.ratingStar == null ? null : Number(row.ratingStar),
    ratingCount: toNumberOrNull(row.ratingCount),
    stock:
      row.hasModel == null
        ? toNumberOrNull(row.stock)
        : Boolean(row.hasModel)
          ? toNumberOrNull(row.modelsStock) || 0
          : toNumberOrNull(row.stock),
    hasModel: row.hasModel == null ? null : Boolean(row.hasModel),
    modelsStock: toNumberOrNull(row.modelsStock) || 0,
    priceMin: toNumberOrNull(row.priceMin),
    images: row.imageUrl ? [{ url: row.imageUrl }] : [],
  }));
}

async function listProductSalesSnapshotByRange(
  shopId,
  start,
  end,
  { includeInactive = false } = {},
) {
  const params = [Number(shopId), start, end, SALES_EXCLUDED_STATUSES];
  let activeStatusWhereClause = "";
  if (!includeInactive) {
    params.push(ACTIVE_PRODUCT_STATUSES);
    activeStatusWhereClause = `
      AND UPPER(TRIM(COALESCE(p.status, ''))) = ANY($5::text[])
    `;
  }

  const result = await query(
    `
      WITH sales AS (
        SELECT
          oi."productId" AS "productId",
          COALESCE(SUM(oi.quantity), 0)::int AS quantity,
          COUNT(DISTINCT oi."orderId")::int AS orders,
          COALESCE(
            SUM(
              CASE
                WHEN oi."orderPrice" IS NOT NULL THEN oi."orderPrice"::numeric
                WHEN oi."dealPrice" IS NOT NULL THEN ROUND(
                  oi."dealPrice"::numeric * 100 * COALESCE(NULLIF(oi.quantity::text, '')::numeric, 1)
                )
                WHEN oi."variationPrice" IS NOT NULL THEN ROUND(
                  oi."variationPrice"::numeric * 100 * COALESCE(NULLIF(oi.quantity::text, '')::numeric, 1)
                )
                ELSE 0
              END
            ),
            0
          )::bigint AS "revenueCents"
        FROM "OrderItem" oi
        INNER JOIN "Order" o ON o.id = oi."orderId"
        WHERE oi."shopId" = $1
          AND oi."productId" IS NOT NULL
          AND o."orderStatus" IS NOT NULL
          AND o."orderStatus" <> ALL($4::text[])
          AND (
            (o."shopeeCreateTime" >= $2 AND o."shopeeCreateTime" <= $3)
            OR (
              o."shopeeCreateTime" IS NULL
              AND o."createdAt" >= $2
              AND o."createdAt" <= $3
            )
          )
        GROUP BY oi."productId"
      ),
      last_sales AS (
        SELECT
          oi."productId" AS "productId",
          MAX(COALESCE(o."shopeeCreateTime", o."createdAt")) AS "lastSaleAt"
        FROM "OrderItem" oi
        INNER JOIN "Order" o ON o.id = oi."orderId"
        WHERE oi."shopId" = $1
          AND oi."productId" IS NOT NULL
          AND o."orderStatus" IS NOT NULL
          AND o."orderStatus" <> ALL($4::text[])
        GROUP BY oi."productId"
      )
      SELECT
        p.id,
        p."itemId",
        p."categoryId",
        p.status,
        p.title,
        p."itemSku",
        p."ratingStar",
        p."ratingCount",
        p."hasModel",
        p.stock,
        (
          SELECT COALESCE(SUM(pm.stock), 0)::int
          FROM "ProductModel" pm
          WHERE pm."productId" = p.id
        ) AS "modelsStock",
        p.brand,
        p.attributes,
        p."createdAt",
        p."shopeeCreateTime",
        ls."lastSaleAt",
        COALESCE(s.quantity, 0)::int AS quantity,
        COALESCE(s.orders, 0)::int AS orders,
        COALESCE(s."revenueCents", 0)::bigint AS "revenueCents",
        (
          SELECT pi.url
          FROM "ProductImage" pi
          WHERE pi."productId" = p.id
          ORDER BY pi.id ASC
          LIMIT 1
        ) AS "imageUrl"
      FROM "Product" p
      LEFT JOIN sales s ON s."productId" = p.id
      LEFT JOIN last_sales ls ON ls."productId" = p.id
      WHERE p."shopId" = $1
      ${activeStatusWhereClause}
      ORDER BY COALESCE(s."revenueCents", 0) DESC, COALESCE(s.quantity, 0) DESC, p.id ASC
    `,
    params,
  );

  return result.rows.map(mapProductSalesSnapshotRow);
}

async function listLowRatingProducts(shopId) {
  const result = await query(
    `
      SELECT
        p.id,
        p."itemId",
        p.title,
        p."itemSku",
        p.sold,
        p."ratingStar",
        p."ratingCount",
        p.stock,
        p."priceMin",
        (
          SELECT pi.url
          FROM "ProductImage" pi
          WHERE pi."productId" = p.id
          ORDER BY pi.id ASC
          LIMIT 1
        ) AS "imageUrl"
      FROM "Product" p
      WHERE p."shopId" = $1
        AND COALESCE(NULLIF(p."ratingCount"::text, '')::int, 0) > 0
        AND COALESCE(NULLIF(p."ratingStar"::text, '')::numeric, 0) <= 3
      ORDER BY p."ratingStar" ASC NULLS LAST, p.id ASC
    `,
    [Number(shopId)],
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    itemId: toBigIntOrNull(row.itemId),
    title: row.title || null,
    itemSku: row.itemSku || null,
    sold: toNumberOrNull(row.sold),
    ratingStar: row.ratingStar == null ? null : Number(row.ratingStar),
    ratingCount: toNumberOrNull(row.ratingCount),
    stock: toNumberOrNull(row.stock),
    priceMin: toNumberOrNull(row.priceMin),
    images: row.imageUrl ? [{ url: row.imageUrl }] : [],
  }));
}

async function listProductItemIdsByDbIds(shopId, productIds = []) {
  const normalizedIds = (Array.isArray(productIds) ? productIds : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);

  if (!normalizedIds.length) {
    return [];
  }

  const result = await query(
    `
      SELECT "itemId", status, title
      FROM "Product"
      WHERE "shopId" = $1
        AND id = ANY($2::int[])
      ORDER BY id ASC
    `,
    [Number(shopId), normalizedIds],
  );

  return result.rows.map((row) => ({
    itemId: toBigIntOrNull(row.itemId),
    status: row.status || null,
    title: row.title || null,
  }));
}

async function listSeoReferenceProducts(shopId, q, limit = 30) {
  const queryText = String(q || "").trim();
  const normalizedItemId = normalizeItemId(queryText);

  const result = await query(
    `
      SELECT
        p."itemId",
        p.title,
        (
          SELECT pi.url
          FROM "ProductImage" pi
          WHERE pi."productId" = p.id
          ORDER BY pi.id ASC
          LIMIT 1
        ) AS "imageUrl"
      FROM "Product" p
      WHERE p."shopId" = $1
        AND (
          $2::text = ''
          OR ($3::text <> '' AND p."itemId" = $3::bigint)
          OR COALESCE(p.title, '') ILIKE '%' || $2 || '%'
        )
      ORDER BY p."updatedAt" DESC NULLS LAST, p.id DESC
      LIMIT $4
    `,
    [Number(shopId), queryText, normalizedItemId || "", Number(limit)],
  );

  return result.rows.map((row) => ({
    itemId: toBigIntOrNull(row.itemId),
    title: row.title || null,
    images: row.imageUrl ? [{ url: row.imageUrl }] : [],
  }));
}

module.exports = {
  countCatalogProducts,
  countProductsForManagement,
  findProductDetailByShopAndItemId,
  findProductIdByShopAndItemId,
  listProductsByShopAndIdentifiers,
  listCatalogProducts,
  listGroupedProductSalesSince,
  listLowRatingProducts,
  listProductCardsByIds,
  listProductItemIdsByDbIds,
  listProductSalesSnapshotByRange,
  listProductsForManagementExport,
  listProductsForManagement,
  mapSoldQuantityByItemIds,
  listProductsByShopAndItemIdsForLogistics,
  listProductsByShopAndItemIdsForLogisticsAnyStatus,
  listProductsByShopAndItemIdsForManagement,
  listProductsForLogistics,
  listProductsWithoutSalesSince,
  listVariationSalesByProductId,
  listSeoReferenceProducts,
  replaceProductImages,
  updateProductById,
  updateProductByShopAndItemId,
  _test: {
    buildProductsListWhereClause,
  },
};
