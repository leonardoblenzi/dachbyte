"use strict";

const { query, queryOne } = require("../config/postgres");

const PAID_EXCLUDED_STATUSES = ["CANCELLED", "UNPAID", "TO_RETURN"];
const ACTIVE_PRODUCT_STATUSES = ["NORMAL", "ACTIVE"];
const PAUSED_PRODUCT_STATUSES = ["UNLIST", "UNLISTED"];
const EXCLUDED_CARRIERS = [
  "retirada normal na agencia",
  "retirada normal na agência",
];

function buildOrderRangeClause(alias, fromParam, toParam) {
  return `(
    (${alias}."shopeeCreateTime" >= ${fromParam} AND ${alias}."shopeeCreateTime" <= ${toParam})
    OR (
      ${alias}."shopeeCreateTime" IS NULL
      AND ${alias}."createdAt" >= ${fromParam}
      AND ${alias}."createdAt" <= ${toParam}
    )
  )`;
}

function buildExcludedCarrierClause(alias, carrierParam) {
  return `LOWER(COALESCE(${alias}."shippingCarrier", '')) <> ALL(${carrierParam}::text[])`;
}

async function aggregatePaidOrdersInRange(shopId, from, to) {
  const row = await queryOne(
    `
      SELECT
        COALESCE(SUM(COALESCE(NULLIF(o."gmvCents"::text, '')::numeric, 0)), 0)::bigint AS total,
        COUNT(*)::int AS count
      FROM "Order" o
      WHERE o."shopId" = $1
        AND o."orderStatus" IS NOT NULL
        AND o."orderStatus" <> ALL($4::text[])
        AND ${buildExcludedCarrierClause("o", "$5")}
        AND ${buildOrderRangeClause("o", "$2", "$3")}
    `,
    [Number(shopId), from, to, PAID_EXCLUDED_STATUSES, EXCLUDED_CARRIERS],
  );

  return {
    total: Number(row?.total || 0),
    count: Number(row?.count || 0),
  };
}

async function listPaidOrdersInRange(shopId, from, to, orderDirection = "DESC") {
  const direction = String(orderDirection).toUpperCase() === "ASC" ? "ASC" : "DESC";
  const result = await query(
    `
      SELECT
        id,
        "gmvCents",
        "shopeeCreateTime",
        "createdAt"
      FROM "Order" o
      WHERE o."shopId" = $1
        AND o."orderStatus" IS NOT NULL
        AND o."orderStatus" <> ALL($4::text[])
        AND ${buildExcludedCarrierClause("o", "$5")}
        AND ${buildOrderRangeClause("o", "$2", "$3")}
      ORDER BY o."shopeeCreateTime" ${direction} NULLS LAST, o."createdAt" ${direction}, o.id ${direction}
    `,
    [Number(shopId), from, to, PAID_EXCLUDED_STATUSES, EXCLUDED_CARRIERS],
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    gmvCents: Number(row.gmvCents || 0),
    shopeeCreateTime: row.shopeeCreateTime || null,
    createdAt: row.createdAt,
  }));
}

async function groupTopProductsByQuantitySince(shopId, from, limit = 10) {
  const result = await query(
    `
      SELECT
        oi."productId" AS "productId",
        COALESCE(SUM(oi.quantity), 0)::int AS quantity
      FROM "OrderItem" oi
      INNER JOIN "Order" o ON o.id = oi."orderId"
      INNER JOIN "Product" p
        ON p.id = oi."productId"
        AND p."shopId" = oi."shopId"
      WHERE oi."shopId" = $1
        AND oi."productId" IS NOT NULL
        AND o."shopeeCreateTime" >= $2
        AND ${buildExcludedCarrierClause("o", "$3")}
        AND UPPER(COALESCE(p.status, '')) = ANY($5::text[])
      GROUP BY oi."productId"
      ORDER BY quantity DESC, oi."productId" ASC
      LIMIT $4
    `,
    [
      Number(shopId),
      from,
      EXCLUDED_CARRIERS,
      Number(limit),
      ACTIVE_PRODUCT_STATUSES,
    ],
  );

  return result.rows.map((row) => ({
    productId: Number(row.productId),
    quantity: Number(row.quantity || 0),
  }));
}

async function listOrderItemsForProductsSince(shopId, productIds, from) {
  const normalizedIds = (Array.isArray(productIds) ? productIds : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);

  if (!normalizedIds.length) {
    return [];
  }

  const result = await query(
    `
      SELECT
        oi."productId" AS "productId",
        oi.quantity,
        oi."orderId" AS "orderId"
      FROM "OrderItem" oi
      INNER JOIN "Order" o ON o.id = oi."orderId"
      INNER JOIN "Product" p
        ON p.id = oi."productId"
        AND p."shopId" = oi."shopId"
      WHERE oi."shopId" = $1
        AND oi."productId" = ANY($2::int[])
        AND o."shopeeCreateTime" >= $3
        AND ${buildExcludedCarrierClause("o", "$4")}
        AND UPPER(COALESCE(p.status, '')) = ANY($5::text[])
    `,
    [Number(shopId), normalizedIds, from, EXCLUDED_CARRIERS, ACTIVE_PRODUCT_STATUSES],
  );

  return result.rows.map((row) => ({
    productId: Number(row.productId),
    quantity: Number(row.quantity || 0),
    orderId: Number(row.orderId),
  }));
}

async function listOrdersGmvByIds(orderIds) {
  const normalizedIds = (Array.isArray(orderIds) ? orderIds : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);

  if (!normalizedIds.length) {
    return [];
  }

  const result = await query(
    `
      SELECT id, "gmvCents"
      FROM "Order"
      WHERE id = ANY($1::int[])
    `,
    [normalizedIds],
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    gmvCents: Number(row.gmvCents || 0),
  }));
}

async function countProductsForShop(shopId) {
  const row = await queryOne(
    `
      SELECT COUNT(*)::int AS total
      FROM "Product"
      WHERE "shopId" = $1
        AND UPPER(COALESCE(status, '')) = ANY($2::text[])
    `,
    [Number(shopId), ACTIVE_PRODUCT_STATUSES],
  );

  return Number(row?.total || 0);
}

async function countPausedProductsForShop(shopId) {
  const row = await queryOne(
    `
      SELECT COUNT(*)::int AS total
      FROM "Product"
      WHERE "shopId" = $1
        AND UPPER(COALESCE(status, '')) = ANY($2::text[])
    `,
    [Number(shopId), PAUSED_PRODUCT_STATUSES],
  );

  return Number(row?.total || 0);
}

async function countSpxEnabledActiveProductsForShop(shopId) {
  const row = await queryOne(
    `
      SELECT COUNT(*)::int AS total
      FROM "Product"
      WHERE "shopId" = $1
        AND UPPER(COALESCE(status, '')) = ANY($2::text[])
        AND COALESCE("spxEnabledCache", false) = true
    `,
    [Number(shopId), ACTIVE_PRODUCT_STATUSES],
  );

  return Number(row?.total || 0);
}

async function countOrdersInRange(shopId, from, to) {
  const row = await queryOne(
    `
      SELECT COUNT(*)::int AS total
      FROM "Order" o
      WHERE o."shopId" = $1
        AND ${buildExcludedCarrierClause("o", "$4")}
        AND ${buildOrderRangeClause("o", "$2", "$3")}
    `,
    [Number(shopId), from, to, EXCLUDED_CARRIERS],
  );

  return Number(row?.total || 0);
}

async function countPaidOrdersInRange(shopId, from, to) {
  const row = await queryOne(
    `
      SELECT COUNT(*)::int AS total
      FROM "Order" o
      WHERE o."shopId" = $1
        AND o."orderStatus" IS NOT NULL
        AND o."orderStatus" <> ALL($4::text[])
        AND ${buildExcludedCarrierClause("o", "$5")}
        AND ${buildOrderRangeClause("o", "$2", "$3")}
    `,
    [Number(shopId), from, to, PAID_EXCLUDED_STATUSES, EXCLUDED_CARRIERS],
  );

  return Number(row?.total || 0);
}

async function countCancelledPaidOrdersInRange(shopId, from, to) {
  const row = await queryOne(
    `
      SELECT COUNT(*)::int AS total
      FROM "Order" o
      WHERE o."shopId" = $1
        AND o."orderStatus" = 'CANCELLED'
        AND ${buildExcludedCarrierClause("o", "$4")}
        AND ${buildOrderRangeClause("o", "$2", "$3")}
        AND (
          o."incomeSyncedAt" IS NOT NULL
          OR o."incomeNetCents" IS NOT NULL
          OR o."incomeStatus" IS NOT NULL
        )
    `,
    [Number(shopId), from, to, EXCLUDED_CARRIERS],
  );

  return Number(row?.total || 0);
}

async function countReturnedOrdersInRange(shopId, from, to) {
  const row = await queryOne(
    `
      SELECT COUNT(*)::int AS total
      FROM "Order" o
      WHERE o."shopId" = $1
        AND o."orderStatus" = ANY($4::text[])
        AND ${buildExcludedCarrierClause("o", "$5")}
        AND ${buildOrderRangeClause("o", "$2", "$3")}
    `,
    [Number(shopId), from, to, ["TO_RETURN", "RETURNED"], EXCLUDED_CARRIERS],
  );

  return Number(row?.total || 0);
}

async function countAdsCampaignGroups(shopId) {
  const row = await queryOne(
    `
      SELECT COUNT(*)::int AS total
      FROM "AdsCampaignGroup"
      WHERE "shopId" = $1
    `,
    [Number(shopId)],
  );

  return Number(row?.total || 0);
}

async function groupSoldProductsByOrderIds(shopId, orderIds) {
  const normalizedIds = (Array.isArray(orderIds) ? orderIds : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);

  if (!normalizedIds.length) {
    return [];
  }

  const result = await query(
    `
      SELECT
        oi."productId" AS "productId",
        COALESCE(SUM(oi.quantity), 0)::int AS quantity
      FROM "OrderItem" oi
      INNER JOIN "Product" p
        ON p.id = oi."productId"
        AND p."shopId" = oi."shopId"
      WHERE oi."shopId" = $1
        AND oi."orderId" = ANY($2::int[])
        AND oi."productId" IS NOT NULL
        AND UPPER(COALESCE(p.status, '')) = ANY($3::text[])
      GROUP BY oi."productId"
    `,
    [Number(shopId), normalizedIds, ACTIVE_PRODUCT_STATUSES],
  );

  return result.rows.map((row) => ({
    productId: Number(row.productId),
    quantity: Number(row.quantity || 0),
  }));
}

async function listProductTitlesByIds(productIds) {
  const normalizedIds = (Array.isArray(productIds) ? productIds : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);

  if (!normalizedIds.length) {
    return [];
  }

  const result = await query(
    `
      SELECT id, title
      FROM "Product"
      WHERE id = ANY($1::int[])
    `,
    [normalizedIds],
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    title: row.title || null,
  }));
}

async function listProductsWithRatings(shopId) {
  const result = await query(
    `
      SELECT "ratingStar", "ratingCount"
      FROM "Product"
      WHERE "shopId" = $1
        AND "ratingStar" IS NOT NULL
        AND COALESCE(NULLIF("ratingCount"::text, '')::int, 0) > 0
    `,
    [Number(shopId)],
  );

  return result.rows.map((row) => ({
    ratingStar: row.ratingStar == null ? null : Number(row.ratingStar),
    ratingCount: Number(row.ratingCount || 0),
  }));
}

module.exports = {
  aggregatePaidOrdersInRange,
  countAdsCampaignGroups,
  countCancelledPaidOrdersInRange,
  countOrdersInRange,
  countPaidOrdersInRange,
  countPausedProductsForShop,
  countSpxEnabledActiveProductsForShop,
  countProductsForShop,
  countReturnedOrdersInRange,
  groupSoldProductsByOrderIds,
  groupTopProductsByQuantitySince,
  listOrderItemsForProductsSince,
  listOrdersGmvByIds,
  listPaidOrdersInRange,
  listProductTitlesByIds,
  listProductsWithRatings,
};
