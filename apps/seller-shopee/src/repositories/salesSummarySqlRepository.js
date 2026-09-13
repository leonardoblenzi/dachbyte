"use strict";

const { query } = require("../config/postgres");

const PAID_REPORT_EXCLUDED_STATUSES = ["CANCELLED", "UNPAID", "IN_CANCEL"];
const EXCLUDED_CARRIERS = [
  "retirada normal na agencia",
  "retirada normal na agência",
];

function normalizeShopIds(shopIds = []) {
  return (Array.isArray(shopIds) ? shopIds : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function buildExcludedCarrierClause(alias, carrierParam) {
  return `LOWER(COALESCE(${alias}."shippingCarrier", '')) <> ALL(${carrierParam}::text[])`;
}

function buildRangeClause(alias, fromParam, toParam) {
  return `(
    (${alias}."shopeeCreateTime" >= ${fromParam} AND ${alias}."shopeeCreateTime" < ${toParam})
    OR (
      ${alias}."shopeeCreateTime" IS NULL
      AND ${alias}."createdAt" >= ${fromParam}
      AND ${alias}."createdAt" < ${toParam}
    )
  )`;
}

function mapOrderRow(row) {
  return {
    id: Number(row.id),
    orderSn: row.order_sn,
    orderStatus: row.order_status || null,
    gmvCents: Number(row.gmv_cents || 0),
    shopeeCreateTime: row.shopee_create_time || null,
    createdAt: row.created_at,
    shop: {
      shopId: row.shop_shopee_id == null ? null : BigInt(row.shop_shopee_id),
    },
  };
}

async function listPaidOrdersForRange(shopIds, range, direction = "DESC") {
  const normalizedShopIds = normalizeShopIds(shopIds);
  if (!normalizedShopIds.length) {
    return [];
  }

  const orderDirection = String(direction).toUpperCase() === "ASC" ? "ASC" : "DESC";
  const result = await query(
    `
      SELECT
        o.id,
        o."orderSn" AS order_sn,
        o."orderStatus" AS order_status,
        o."gmvCents" AS gmv_cents,
        o."shopeeCreateTime" AS shopee_create_time,
        o."createdAt" AS created_at,
        s."shopId" AS shop_shopee_id
      FROM "Order" o
      INNER JOIN "Shop" s ON s.id = o."shopId"
      WHERE o."shopId" = ANY($1::int[])
        AND o."orderStatus" IS NOT NULL
        AND o."orderStatus" <> ALL($4::text[])
        AND ${buildExcludedCarrierClause("o", "$5")}
        AND ${buildRangeClause("o", "$2", "$3")}
      ORDER BY o."shopeeCreateTime" ${orderDirection} NULLS LAST, o."createdAt" ${orderDirection}, o.id ${orderDirection}
    `,
    [normalizedShopIds, range.from, range.to, PAID_REPORT_EXCLUDED_STATUSES, EXCLUDED_CARRIERS],
  );

  return result.rows.map(mapOrderRow);
}

async function listCreatedOrdersForRange(shopIds, range, direction = "DESC") {
  const normalizedShopIds = normalizeShopIds(shopIds);
  if (!normalizedShopIds.length) {
    return [];
  }

  const orderDirection = String(direction).toUpperCase() === "ASC" ? "ASC" : "DESC";
  const result = await query(
    `
      SELECT
        o.id,
        o."orderSn" AS order_sn,
        o."orderStatus" AS order_status,
        o."gmvCents" AS gmv_cents,
        o."shopeeCreateTime" AS shopee_create_time,
        o."createdAt" AS created_at,
        s."shopId" AS shop_shopee_id
      FROM "Order" o
      INNER JOIN "Shop" s ON s.id = o."shopId"
      WHERE o."shopId" = ANY($1::int[])
        AND ${buildExcludedCarrierClause("o", "$4")}
        AND ${buildRangeClause("o", "$2", "$3")}
      ORDER BY o."shopeeCreateTime" ${orderDirection} NULLS LAST, o."createdAt" ${orderDirection}, o.id ${orderDirection}
    `,
    [normalizedShopIds, range.from, range.to, EXCLUDED_CARRIERS],
  );

  return result.rows.map(mapOrderRow);
}

async function listOperationalStatusCounts(shopIds, statuses) {
  const normalizedShopIds = normalizeShopIds(shopIds);
  if (!normalizedShopIds.length) {
    return [];
  }

  const result = await query(
    `
      SELECT
        "orderStatus" AS order_status,
        COUNT(*)::int AS total
      FROM "Order" o
      WHERE o."shopId" = ANY($1::int[])
        AND o."orderStatus" = ANY($2::text[])
        AND ${buildExcludedCarrierClause("o", "$3")}
      GROUP BY "orderStatus"
    `,
    [normalizedShopIds, statuses, EXCLUDED_CARRIERS],
  );

  return result.rows.map((row) => ({
    orderStatus: row.order_status || null,
    total: Number(row.total || 0),
  }));
}

async function listReadyToShipOrders(shopIds) {
  const normalizedShopIds = normalizeShopIds(shopIds);
  if (!normalizedShopIds.length) {
    return [];
  }

  const result = await query(
    `
      SELECT "shipByDate" AS ship_by_date
      FROM "Order" o
      WHERE o."shopId" = ANY($1::int[])
        AND o."orderStatus" = 'READY_TO_SHIP'
        AND ${buildExcludedCarrierClause("o", "$2")}
    `,
    [normalizedShopIds, EXCLUDED_CARRIERS],
  );

  return result.rows.map((row) => ({
    shipByDate: row.ship_by_date || null,
  }));
}

async function listProductTitlesByItemIdsForShops(shopIds, itemIds = []) {
  const normalizedShopIds = normalizeShopIds(shopIds);
  const normalizedItemIds = (Array.isArray(itemIds) ? itemIds : [])
    .map((value) => {
      try {
        return BigInt(value).toString();
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);

  if (!normalizedShopIds.length || !normalizedItemIds.length) {
    return [];
  }

  const result = await query(
    `
      SELECT "itemId" AS item_id, title
      FROM "Product"
      WHERE "shopId" = ANY($1::int[])
        AND "itemId" = ANY($2::bigint[])
    `,
    [normalizedShopIds, normalizedItemIds],
  );

  return result.rows.map((row) => ({
    itemId: row.item_id == null ? null : BigInt(row.item_id),
    title: row.title || null,
  }));
}

async function listDetailedPaidOrdersForRange(shopIds, range) {
  const normalizedShopIds = normalizeShopIds(shopIds);
  if (!normalizedShopIds.length) {
    return [];
  }

  const ordersResult = await query(
    `
      SELECT
        o.id,
        o."orderSn" AS order_sn,
        o."orderStatus" AS order_status,
        o."gmvCents" AS gmv_cents,
        o."shopeeCreateTime" AS shopee_create_time,
        o."createdAt" AS created_at
      FROM "Order" o
      WHERE o."shopId" = ANY($1::int[])
        AND o."orderStatus" IS NOT NULL
        AND o."orderStatus" <> ALL($4::text[])
        AND ${buildExcludedCarrierClause("o", "$5")}
        AND ${buildRangeClause("o", "$2", "$3")}
      ORDER BY o."shopeeCreateTime" ASC NULLS LAST, o."createdAt" ASC, o.id ASC
    `,
    [normalizedShopIds, range.from, range.to, PAID_REPORT_EXCLUDED_STATUSES, EXCLUDED_CARRIERS],
  );

  const orders = ordersResult.rows.map((row) => ({
    id: Number(row.id),
    orderSn: row.order_sn,
    orderStatus: row.order_status || null,
    gmvCents: Number(row.gmv_cents || 0),
    shopeeCreateTime: row.shopee_create_time || null,
    createdAt: row.created_at,
    items: [],
  }));

  if (!orders.length) {
    return orders;
  }

  const orderIds = orders.map((order) => order.id);
  const itemsResult = await query(
    `
      SELECT
        oi."orderId" AS order_id,
        oi."itemId" AS item_id,
        oi."itemName" AS item_name,
        oi.quantity,
        p.title AS product_title
      FROM "OrderItem" oi
      LEFT JOIN "Product" p ON p.id = oi."productId"
      WHERE oi."orderId" = ANY($1::int[])
      ORDER BY oi."orderId" ASC, oi.id ASC
    `,
    [orderIds],
  );

  const itemsByOrderId = new Map();
  for (const row of itemsResult.rows) {
    const orderId = Number(row.order_id);
    if (!itemsByOrderId.has(orderId)) {
      itemsByOrderId.set(orderId, []);
    }

    itemsByOrderId.get(orderId).push({
      itemId: row.item_id == null ? null : BigInt(row.item_id),
      itemName: row.item_name || null,
      quantity: Number(row.quantity || 0),
      product: row.product_title ? { title: row.product_title } : null,
    });
  }

  return orders.map((order) => ({
    ...order,
    items: itemsByOrderId.get(order.id) || [],
  }));
}

async function listProductsWithRatingsByShopIds(shopIds) {
  const normalizedShopIds = normalizeShopIds(shopIds);
  if (!normalizedShopIds.length) {
    return [];
  }

  const result = await query(
    `
      SELECT "itemId" AS item_id, "ratingStar" AS rating_star, "ratingCount" AS rating_count
      FROM "Product"
      WHERE "shopId" = ANY($1::int[])
        AND "ratingStar" IS NOT NULL
        AND COALESCE(NULLIF("ratingCount"::text, '')::int, 0) > 0
    `,
    [normalizedShopIds],
  );

  return result.rows.map((row) => ({
    itemId: row.item_id == null ? null : BigInt(row.item_id),
    ratingStar: Number(row.rating_star || 0),
    ratingCount: Number(row.rating_count || 0),
  }));
}

async function groupAdsSpendByItemIds(shopIds, range) {
  const normalizedShopIds = normalizeShopIds(shopIds);
  if (!normalizedShopIds.length) {
    return [];
  }

  const result = await query(
    `
      SELECT
        "itemId" AS item_id,
        COALESCE(SUM(expense), 0)::bigint AS expense
      FROM "AdsHourlyMetric"
      WHERE "shopId" = ANY($1::int[])
        AND "itemId" IS NOT NULL
        AND date >= $2
        AND date <= $3
      GROUP BY "itemId"
    `,
    [normalizedShopIds, range.from, range.to],
  );

  return result.rows.map((row) => ({
    itemId: row.item_id == null ? null : BigInt(row.item_id),
    expense: Number(row.expense || 0),
  }));
}

async function listAccountsForSalesSummary(accountNameFilter = "") {
  const filter = String(accountNameFilter || "").trim();
  const accountsResult = await query(
    `
      SELECT a.id, a.name
      FROM "Account" a
      WHERE ($1::text = '' OR COALESCE(a.name, '') ILIKE '%' || $1 || '%')
        AND EXISTS (
          SELECT 1
          FROM "Shop" s
          WHERE s."accountId" = a.id
        )
        AND EXISTS (
          SELECT 1
          FROM "User" u
          WHERE u."accountId" = a.id
            AND u.status = 'ACTIVE'
        )
      ORDER BY a.id ASC
    `,
    [filter],
  );

  const accounts = accountsResult.rows.map((row) => ({
    id: Number(row.id),
    name: row.name || null,
    shops: [],
    users: [],
  }));

  if (!accounts.length) {
    return accounts;
  }

  const accountIds = accounts.map((account) => account.id);
  const [shopsResult, usersResult] = await Promise.all([
    query(
      `
        SELECT id, "accountId" AS account_id, "shopId" AS shop_id
        FROM "Shop"
        WHERE "accountId" = ANY($1::int[])
        ORDER BY id ASC
      `,
      [accountIds],
    ),
    query(
      `
        SELECT "accountId" AS account_id, name, email, role, status
        FROM "User"
        WHERE "accountId" = ANY($1::int[])
        ORDER BY id ASC
      `,
      [accountIds],
    ),
  ]);

  const accountMap = new Map(accounts.map((account) => [account.id, account]));

  for (const row of shopsResult.rows) {
    const account = accountMap.get(Number(row.account_id));
    if (!account) continue;
    account.shops.push({
      id: Number(row.id),
      shopId: row.shop_id == null ? null : BigInt(row.shop_id),
    });
  }

  for (const row of usersResult.rows) {
    const account = accountMap.get(Number(row.account_id));
    if (!account) continue;
    account.users.push({
      name: row.name || null,
      email: row.email || null,
      role: row.role || null,
      status: row.status || null,
    });
  }

  return accounts;
}

module.exports = {
  groupAdsSpendByItemIds,
  listAccountsForSalesSummary,
  listCreatedOrdersForRange,
  listDetailedPaidOrdersForRange,
  listOperationalStatusCounts,
  listPaidOrdersForRange,
  listProductTitlesByItemIdsForShops,
  listProductsWithRatingsByShopIds,
  listReadyToShipOrders,
};
