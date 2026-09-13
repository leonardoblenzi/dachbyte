"use strict";

const { query, queryOne } = require("../config/postgres");

const PAID_EXCLUDED_STATUSES = ["CANCELLED", "UNPAID", "TO_RETURN"];

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

function normalizeItemIds(itemIds) {
  const values = [];

  for (const itemId of itemIds || []) {
    if (itemId == null || itemId === "") {
      continue;
    }

    try {
      values.push(BigInt(itemId).toString());
    } catch (_error) {
      continue;
    }
  }

  return Array.from(new Set(values));
}

function mapProductSummaryRow(row) {
  return {
    itemId: toBigIntOrNull(row.itemId),
    title: row.title || null,
    status: row.status || null,
    costCents: toNumberOrNull(row.costCents) || 0,
    images: row.imageUrl ? [{ url: row.imageUrl }] : [],
  };
}

function mapAdsMetricByItemRow(row) {
  return {
    itemId: toBigIntOrNull(row.itemId),
    _sum: {
      impression: toNumberOrNull(row.impression) || 0,
      click: toNumberOrNull(row.click) || 0,
      expense: toNumberOrNull(row.expense) || 0,
      directGmv: toNumberOrNull(row.directGmv) || 0,
      broadGmv: toNumberOrNull(row.broadGmv) || 0,
      directSold: toNumberOrNull(row.directSold) || 0,
      broadSold: toNumberOrNull(row.broadSold) || 0,
    },
  };
}

function mapMarginOrderItemRow(row) {
  const productCostCents = toNumberOrNull(row.productCostCents);
  const productTitle = row.productTitle || null;

  return {
    id: Number(row.id),
    shopId: Number(row.shopId),
    orderId: Number(row.orderId),
    productId: row.productId == null ? null : Number(row.productId),
    itemId: toBigIntOrNull(row.itemId),
    modelId: toBigIntOrNull(row.modelId),
    itemSku: row.itemSku || null,
    modelSku: row.modelSku || null,
    modelName: row.modelName || null,
    itemName: row.itemName || null,
    imageUrl: row.imageUrl || null,
    weight: row.weight == null ? null : Number(row.weight),
    orderPrice: toNumberOrNull(row.orderPrice),
    dealPrice: toNumberOrNull(row.dealPrice),
    variationPrice: toNumberOrNull(row.variationPrice),
    quantity: toNumberOrNull(row.quantity),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    product:
      row.productId == null && productCostCents == null && productTitle == null
        ? null
        : {
            costCents: productCostCents || 0,
            title: productTitle,
          },
  };
}

async function listProductsByShopAndItemIds(shopId, itemIds) {
  const normalizedItemIds = normalizeItemIds(itemIds);
  if (!normalizedItemIds.length) {
    return [];
  }

  const result = await query(
    `
      SELECT
        p."itemId",
        p.title,
        p.status,
        p."costCents",
        img.url AS "imageUrl"
      FROM "Product" p
      LEFT JOIN LATERAL (
        SELECT pi.url
        FROM "ProductImage" pi
        WHERE pi."productId" = p.id
        ORDER BY pi.id ASC
        LIMIT 1
      ) img ON TRUE
      WHERE p."shopId" = $1
        AND p."itemId" = ANY($2::bigint[])
      ORDER BY p.id ASC
    `,
    [Number(shopId), normalizedItemIds],
  );

  return result.rows.map(mapProductSummaryRow);
}

async function listAdsMetricsGroupedByItemId(shopId, start, end) {
  const result = await query(
    `
      SELECT
        "itemId",
        COALESCE(SUM(impression), 0)::bigint AS impression,
        COALESCE(SUM(click), 0)::bigint AS click,
        COALESCE(SUM(expense), 0)::bigint AS expense,
        COALESCE(SUM("directGmv"), 0)::bigint AS "directGmv",
        COALESCE(SUM("broadGmv"), 0)::bigint AS "broadGmv",
        COALESCE(SUM("directSold"), 0)::bigint AS "directSold",
        COALESCE(SUM("broadSold"), 0)::bigint AS "broadSold"
      FROM "AdsHourlyMetric"
      WHERE "shopId" = $1
        AND "itemId" IS NOT NULL
        AND date >= $2
        AND date <= $3
      GROUP BY "itemId"
    `,
    [Number(shopId), start, end],
  );

  return result.rows.map(mapAdsMetricByItemRow);
}

async function sumStorePaidRevenueCents(shopId, start, end) {
  const row = await queryOne(
    `
      SELECT COALESCE(
        SUM(
          CASE
            WHEN COALESCE(NULLIF(o."totalAmountCents"::text, '')::numeric, 0) > 0
              THEN COALESCE(NULLIF(o."totalAmountCents"::text, '')::numeric, 0)
            ELSE COALESCE(NULLIF(o."gmvCents"::text, '')::numeric, 0)
          END
        ),
        0
      )::bigint AS total
      FROM "Order" o
      WHERE o."shopId" = $1
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
    `,
    [Number(shopId), start, end, PAID_EXCLUDED_STATUSES],
  );

  return Number(row?.total || 0);
}

async function aggregateAdsMetricsByShopAndRange(shopId, start, end, type = "CPC") {
  const row = await queryOne(
    `
      SELECT
        COALESCE(SUM(expense), 0)::bigint AS expense,
        COALESCE(SUM("broadGmv"), 0)::bigint AS "broadGmv",
        COALESCE(SUM("directGmv"), 0)::bigint AS "directGmv",
        COALESCE(SUM("broadSold"), 0)::bigint AS "broadSold",
        COALESCE(SUM("directSold"), 0)::bigint AS "directSold"
      FROM "AdsHourlyMetric"
      WHERE "shopId" = $1
        AND type = $2
        AND date >= $3
        AND date <= $4
    `,
    [Number(shopId), String(type), start, end],
  );

  return {
    _sum: {
      expense: Number(row?.expense || 0),
      broadGmv: Number(row?.broadGmv || 0),
      directGmv: Number(row?.directGmv || 0),
      broadSold: Number(row?.broadSold || 0),
      directSold: Number(row?.directSold || 0),
    },
  };
}

async function aggregateAttributedOrdersByShopAndRange(
  shopId,
  start,
  end,
  adsType = "CPC",
) {
  const row = await queryOne(
    `
      SELECT
        COUNT(*)::int AS total,
        COALESCE(SUM(COALESCE(NULLIF(o."gmvCents"::text, '')::numeric, 0)), 0)::bigint AS "gmvCents"
      FROM "Order" o
      INNER JOIN "OrderAdsAttribution" a ON a."orderId" = o.id
      WHERE o."shopId" = $1
        AND a."adsType" = $2
        AND a."createdAt" >= $3
        AND a."createdAt" <= $4
        AND o."orderStatus" IS NOT NULL
        AND o."orderStatus" <> ALL($5::text[])
    `,
    [Number(shopId), String(adsType), start, end, PAID_EXCLUDED_STATUSES],
  );

  return {
    _sum: {
      gmvCents: Number(row?.gmvCents || 0),
    },
    _count: {
      id: Number(row?.total || 0),
    },
  };
}

async function aggregateAttributedOrderItemsByShopAndRange(
  shopId,
  start,
  end,
  adsType = "CPC",
) {
  const row = await queryOne(
    `
      SELECT COALESCE(SUM(oi.quantity), 0)::bigint AS quantity
      FROM "OrderItem" oi
      INNER JOIN "Order" o ON o.id = oi."orderId"
      INNER JOIN "OrderAdsAttribution" a ON a."orderId" = o.id
      WHERE oi."shopId" = $1
        AND a."adsType" = $2
        AND a."createdAt" >= $3
        AND a."createdAt" <= $4
        AND o."orderStatus" IS NOT NULL
        AND o."orderStatus" <> ALL($5::text[])
    `,
    [Number(shopId), String(adsType), start, end, PAID_EXCLUDED_STATUSES],
  );

  return {
    _sum: {
      quantity: Number(row?.quantity || 0),
    },
  };
}

async function findShopTaxRateById(shopId) {
  const row = await queryOne(
    `
      SELECT "taxRate"
      FROM "Shop"
      WHERE id = $1
      LIMIT 1
    `,
    [Number(shopId)],
  );

  return row
    ? {
        taxRate: toNumberOrNull(row.taxRate) || 0,
      }
    : null;
}

async function listMarginOrdersWithItems(
  shopId,
  start,
  end,
  excludedStatuses = [],
) {
  const ordersResult = await query(
    `
      SELECT *
      FROM "Order"
      WHERE "shopId" = $1
        AND "orderStatus" IS NOT NULL
        AND "orderStatus" <> ALL($4::text[])
        AND (
          ("shopeeCreateTime" >= $2 AND "shopeeCreateTime" <= $3)
          OR (
            "shopeeCreateTime" IS NULL
            AND "createdAt" >= $2
            AND "createdAt" <= $3
          )
        )
      ORDER BY "shopeeCreateTime" DESC NULLS LAST, id DESC
    `,
    [Number(shopId), start, end, excludedStatuses],
  );

  if (!ordersResult.rows.length) {
    return [];
  }

  const orders = ordersResult.rows.map((row) => ({
    ...row,
    items: [],
  }));
  const orderIds = orders.map((order) => Number(order.id));

  const itemsResult = await query(
    `
      SELECT
        oi.*,
        p."costCents" AS "productCostCents",
        p.title AS "productTitle"
      FROM "OrderItem" oi
      LEFT JOIN "Product" p ON p.id = oi."productId"
      WHERE oi."orderId" = ANY($1::int[])
      ORDER BY oi."orderId" ASC, oi.id ASC
    `,
    [orderIds],
  );

  const itemsByOrderId = new Map();
  for (const row of itemsResult.rows) {
    const key = Number(row.orderId);
    if (!itemsByOrderId.has(key)) {
      itemsByOrderId.set(key, []);
    }
    itemsByOrderId.get(key).push(mapMarginOrderItemRow(row));
  }

  return orders.map((order) => ({
    ...order,
    items: itemsByOrderId.get(Number(order.id)) || [],
  }));
}

async function sumAdsSpendByShopAndRange(shopId, start, end, type = null) {
  const hasTypeFilter = type != null && String(type).trim() !== "";
  const row = await queryOne(
    `
      SELECT COALESCE(SUM(expense), 0)::bigint AS total
      FROM "AdsHourlyMetric"
      WHERE "shopId" = $1
        ${hasTypeFilter ? "AND type = $2" : ""}
        AND date >= $${hasTypeFilter ? 3 : 2}
        AND date <= $${hasTypeFilter ? 4 : 3}
    `,
    hasTypeFilter
      ? [Number(shopId), String(type), start, end]
      : [Number(shopId), start, end],
  );

  return Number(row?.total || 0);
}

module.exports = {
  aggregateAdsMetricsByShopAndRange,
  aggregateAttributedOrderItemsByShopAndRange,
  aggregateAttributedOrdersByShopAndRange,
  findShopTaxRateById,
  listAdsMetricsGroupedByItemId,
  listMarginOrdersWithItems,
  listProductsByShopAndItemIds,
  sumAdsSpendByShopAndRange,
  sumStorePaidRevenueCents,
};
