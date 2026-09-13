"use strict";

const { query, queryOne } = require("../config/postgres");

const EXCLUDED_CHANNEL_LOGISTICS_CARRIERS = [
  "retirada normal na agência",
  "retirada normal na agencia",
];

const HIDDEN_STATUSES = [
  "COMPLETED",
  "CANCELLED",
  "RETURNED",
  "TO_CONFIRM_RECEIVE",
  "IN_CANCEL",
  "TO_RETURN",
];

let orderPackageColumnsPromise = null;

async function ensureOrderPackageColumns() {
  if (orderPackageColumnsPromise) return orderPackageColumnsPromise;

  orderPackageColumnsPromise = (async () => {
    await query(`
      ALTER TABLE "Order"
        ADD COLUMN IF NOT EXISTS "orderId" BIGINT,
        ADD COLUMN IF NOT EXISTS "packageNumber" TEXT,
        ADD COLUMN IF NOT EXISTS "packageFulfillmentStatus" TEXT,
        ADD COLUMN IF NOT EXISTS "packageLogisticsChannelId" BIGINT,
        ADD COLUMN IF NOT EXISTS "packageTrackingNumber" TEXT,
        ADD COLUMN IF NOT EXISTS "packageShipByDate" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "packagePickupDoneTime" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "estimatedDeliveryTime" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "estimatedDeliveryStartTime" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "estimatedDeliveryEndTime" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "preparationEndTime" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "driverEtaStartTime" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "driverEtaEndTime" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "packageDetailRaw" JSONB
    `);
  })().catch((error) => {
    orderPackageColumnsPromise = null;
    throw error;
  });

  return orderPackageColumnsPromise;
}

function mapPreviewOrderRow(row) {
  return {
    id: Number(row.id),
    orderId: row.orderId == null ? null : String(row.orderId),
    orderSn: row.orderSn,
    orderStatus: row.orderStatus || null,
    shipByDate: row.shipByDate,
    daysToShip: row.daysToShip,
    shopeeCreateTime: row.shopeeCreateTime,
    shopeeUpdateTime: row.shopeeUpdateTime,
    gmvCents: row.gmvCents,
    incomeNetCents: row.incomeNetCents,
    paymentMethod: row.paymentMethod || null,
    packageNumber: row.packageNumber || null,
    packageFulfillmentStatus: row.packageFulfillmentStatus || null,
    packageTrackingNumber: row.packageTrackingNumber || null,
    packageShipByDate: row.packageShipByDate || null,
    packagePickupDoneTime: row.packagePickupDoneTime || null,
    estimatedDeliveryTime: row.estimatedDeliveryTime || null,
    estimatedDeliveryStartTime: row.estimatedDeliveryStartTime || null,
    estimatedDeliveryEndTime: row.estimatedDeliveryEndTime || null,
    preparationEndTime: row.preparationEndTime || null,
    driverEtaStartTime: row.driverEtaStartTime || null,
    driverEtaEndTime: row.driverEtaEndTime || null,
    customerName: row.customerName || null,
    items: Array.isArray(row.items) ? row.items : [],
    _count: {
      items: Number(row.itemsCount || 0),
    },
  };
}

function mapOrderItemRow(row) {
  return {
    id: Number(row.id),
    shopId: row.shopId == null ? null : Number(row.shopId),
    orderId: row.orderId == null ? null : Number(row.orderId),
    productId: row.productId == null ? null : Number(row.productId),
    itemId: row.itemId == null ? null : BigInt(row.itemId),
    modelId: row.modelId == null ? null : BigInt(row.modelId),
    itemSku: row.itemSku || null,
    modelSku: row.modelSku || null,
    modelName: row.modelName || null,
    itemName: row.itemName || null,
    imageUrl: row.imageUrl || null,
    weight: row.weight == null ? null : Number(row.weight),
    orderPrice: row.orderPrice == null ? null : Number(row.orderPrice),
    dealPrice: row.dealPrice == null ? null : Number(row.dealPrice),
    variationPrice: row.variationPrice == null ? null : Number(row.variationPrice),
    quantity: row.quantity == null ? null : Number(row.quantity),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapAddressSnapshotRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    orderId: row.orderId == null ? null : Number(row.orderId),
    name: row.name || null,
    phone: row.phone || null,
    town: row.town || null,
    district: row.district || null,
    city: row.city || null,
    state: row.state || null,
    region: row.region || null,
    zipcode: row.zipcode || null,
    fullAddress: row.fullAddress || null,
    addressHash: row.addressHash,
    createdAt: row.createdAt,
  };
}

function buildOrderWhereClause({
  shopId,
  statuses = null,
  orderSn = null,
  search = null,
  excludeHiddenStatuses = false,
}) {
  const params = [Number(shopId)];
  const clauses = [`o."shopId" = $1`];

  if (Array.isArray(statuses) && statuses.length > 0) {
    params.push(statuses);
    clauses.push(`o."orderStatus" = ANY($${params.length}::text[])`);
  } else if (excludeHiddenStatuses) {
    params.push(HIDDEN_STATUSES);
    clauses.push(
      `(o."orderStatus" IS NULL OR o."orderStatus" <> ALL($${params.length}::text[]))`,
    );
  }

  params.push(EXCLUDED_CHANNEL_LOGISTICS_CARRIERS);
  clauses.push(
    `LOWER(COALESCE(o."shippingCarrier", '')) <> ALL($${params.length}::text[])`,
  );

  if (orderSn != null) {
    params.push(String(orderSn));
    clauses.push(`o."orderSn" = $${params.length}`);
  }

  const normalizedSearch = String(search || "").trim();
  if (normalizedSearch) {
    params.push(`%${normalizedSearch}%`);
    const searchParam = `$${params.length}`;
    clauses.push(`(
      o."orderSn" ILIKE ${searchParam}
      OR EXISTS (
        SELECT 1
        FROM "OrderAddressSnapshot" s
        WHERE s."orderId" = o.id
          AND COALESCE(s.name, '') ILIKE ${searchParam}
      )
    )`);
  }

  return {
    params,
    whereSql: clauses.join("\n        AND "),
  };
}

async function countOrdersForShop({
  shopId,
  statuses = null,
  search = null,
  excludeHiddenStatuses = false,
}) {
  await ensureOrderPackageColumns();
  const { params, whereSql } = buildOrderWhereClause({
    shopId,
    statuses,
    search,
    excludeHiddenStatuses,
  });

  const row = await queryOne(
    `
      SELECT COUNT(*)::int AS total
      FROM "Order" o
      WHERE ${whereSql}
    `,
    params,
  );

  return Number(row?.total || 0);
}

async function listOrdersForShop({
  shopId,
  statuses = null,
  search = null,
  excludeHiddenStatuses = false,
  limit,
  offset = 0,
}) {
  await ensureOrderPackageColumns();
  const { params, whereSql } = buildOrderWhereClause({
    shopId,
    statuses,
    search,
    excludeHiddenStatuses,
  });

  params.push(Number(limit));
  const limitParam = `$${params.length}`;
  params.push(Number(offset));
  const offsetParam = `$${params.length}`;

  const result = await query(
    `
      SELECT
        o.id,
        o."orderId",
        o."orderSn",
        o."orderStatus",
        o."shipByDate",
        o."daysToShip",
        o."shopeeCreateTime",
        o."shopeeUpdateTime",
        o."gmvCents",
        o."incomeNetCents",
        o."paymentMethod",
        o."packageNumber",
        o."packageFulfillmentStatus",
        o."packageTrackingNumber",
        o."packageShipByDate",
        o."packagePickupDoneTime",
        o."estimatedDeliveryTime",
        o."estimatedDeliveryStartTime",
        o."estimatedDeliveryEndTime",
        o."preparationEndTime",
        o."driverEtaStartTime",
        o."driverEtaEndTime",
        (
          SELECT s.name
          FROM "OrderAddressSnapshot" s
          WHERE s."orderId" = o.id
          ORDER BY s."createdAt" DESC, s.id DESC
          LIMIT 1
        ) AS "customerName",
        (
          SELECT COALESCE(
            json_agg(
              json_build_object(
                'itemName', preview."itemName",
                'modelName', preview."modelName",
                'modelSku', preview."modelSku",
                'quantity', preview.quantity,
                'dealPrice', preview."dealPrice",
                'imageUrl', preview."imageUrl"
              )
              ORDER BY preview.id ASC
            ),
            '[]'::json
          )
          FROM (
            SELECT
              id,
              "itemName",
              "modelName",
              "modelSku",
              quantity,
              "dealPrice",
              "imageUrl"
            FROM "OrderItem"
            WHERE "orderId" = o.id
            ORDER BY id ASC
            LIMIT 3
          ) preview
        ) AS items,
        (
          SELECT COUNT(*)::int
          FROM "OrderItem"
          WHERE "orderId" = o.id
        ) AS "itemsCount"
      FROM "Order" o
      WHERE ${whereSql}
      ORDER BY o."shopeeUpdateTime" DESC NULLS LAST, o.id DESC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    `,
    params,
  );

  return result.rows.map(mapPreviewOrderRow);
}

async function listPendingAddressAlertCountsByOrderIds(orderIds) {
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return [];
  }

  const result = await query(
    `
      SELECT
        "orderId",
        COUNT(*)::int AS total
      FROM "OrderAddressChangeAlert"
      WHERE status = 'PENDING'
        AND "orderId" = ANY($1::int[])
      GROUP BY "orderId"
    `,
    [orderIds.map((value) => Number(value))],
  );

  return result.rows.map((row) => ({
    orderId: Number(row.orderId),
    total: Number(row.total || 0),
  }));
}

async function findOrderDetailByShopAndOrderSn(shopId, orderSn) {
  await ensureOrderPackageColumns();
  const { params, whereSql } = buildOrderWhereClause({
    shopId,
    orderSn,
  });

  const order = await queryOne(
    `
      SELECT o.*
      FROM "Order" o
      WHERE ${whereSql}
      LIMIT 1
    `,
    params,
  );

  if (!order) {
    return null;
  }

  const [itemsResult, snapshot] = await Promise.all([
    query(
      `
        SELECT *
        FROM "OrderItem"
        WHERE "orderId" = $1
        ORDER BY id ASC
      `,
      [order.id],
    ),
    queryOne(
      `
        SELECT *
        FROM "OrderAddressSnapshot"
        WHERE "orderId" = $1
        ORDER BY "createdAt" DESC, id DESC
        LIMIT 1
      `,
      [order.id],
    ),
  ]);

  return {
    ...order,
    items: itemsResult.rows.map(mapOrderItemRow),
    addressSnapshots: snapshot ? [mapAddressSnapshotRow(snapshot)] : [],
  };
}

async function updateOrderEscrowDetail(orderId, data) {
  const row = await queryOne(
    `
      UPDATE "Order"
      SET
        "incomeSyncedAt" = $2,
        "incomeStatus" = $3,
        "incomeNetCents" = $4,
        "incomeDetailRaw" = $5::jsonb,
        "paymentMethod" = $6,
        "updatedAt" = NOW()
      WHERE id = $1
      RETURNING id
    `,
    [
      Number(orderId),
      data.incomeSyncedAt,
      data.incomeStatus,
      data.incomeNetCents,
      JSON.stringify(data.incomeDetailRaw || {}),
      data.paymentMethod,
    ],
  );

  return Boolean(row);
}

module.exports = {
  countOrdersForShop,
  findOrderDetailByShopAndOrderSn,
  listOrdersForShop,
  listPendingAddressAlertCountsByOrderIds,
  updateOrderEscrowDetail,
};
