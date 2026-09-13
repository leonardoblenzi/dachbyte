"use strict";

const { query, queryOne } = require("../config/postgres");

function toBigIntString(value) {
  return BigInt(String(value)).toString();
}

let orderTableCapabilitiesPromise = null;
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
    await query(`
      CREATE INDEX IF NOT EXISTS "Order_shopId_packageShipByDate_idx"
        ON "Order"("shopId", "packageShipByDate")
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS "Order_shopId_packagePickupDoneTime_idx"
        ON "Order"("shopId", "packagePickupDoneTime")
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS "Order_shopId_estimatedDeliveryTime_idx"
        ON "Order"("shopId", "estimatedDeliveryTime")
    `);
  })().catch((error) => {
    orderPackageColumnsPromise = null;
    throw error;
  });

  return orderPackageColumnsPromise;
}

async function loadOrderTableCapabilities() {
  const row = await queryOne(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'Order'
          AND column_name = 'orderNumber'
      ) AS "hasOrderNumber"
    `,
  );

  return {
    hasOrderNumber: Boolean(row?.hasOrderNumber),
  };
}

async function getOrderTableCapabilities() {
  if (!orderTableCapabilitiesPromise) {
    orderTableCapabilitiesPromise = loadOrderTableCapabilities().catch(
      (error) => {
        orderTableCapabilitiesPromise = null;
        throw error;
      },
    );
  }

  return orderTableCapabilitiesPromise;
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

async function findOrderGeoAddressSummary(orderId) {
  const row = await queryOne(
    `
      SELECT id, city, "fullAddress" AS full_address
      FROM "OrderGeoAddress"
      WHERE "orderId" = $1
      LIMIT 1
    `,
    [Number(orderId)],
  );

  return row
    ? {
        id: Number(row.id),
        city: row.city || null,
        fullAddress: row.full_address || null,
      }
    : null;
}

async function createOrderGeoAddress(payload) {
  await query(
    `
      INSERT INTO "OrderGeoAddress" (
        "shopId",
        "orderId",
        "orderSn",
        state,
        "stateNorm",
        city,
        "cityNorm",
        zipcode,
        "fullAddress",
        "shopeeCreateTime",
        "shopeeUpdateTime"
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `,
    [
      Number(payload.shopId),
      Number(payload.orderId),
      payload.orderSn,
      payload.state,
      payload.stateNorm,
      payload.city || null,
      payload.cityNorm || null,
      payload.zipcode || null,
      payload.fullAddress || null,
      payload.shopeeCreateTime || null,
      payload.shopeeUpdateTime || null,
    ],
  );
}

async function updateOrderGeoAddressByOrderId(orderId, payload) {
  await query(
    `
      UPDATE "OrderGeoAddress"
      SET
        city = COALESCE($2, city),
        "cityNorm" = COALESCE($3, "cityNorm"),
        "fullAddress" = COALESCE($4, "fullAddress"),
        zipcode = COALESCE($5, zipcode),
        "shopeeCreateTime" = $6,
        "shopeeUpdateTime" = $7,
        state = $8,
        "stateNorm" = $9
      WHERE "orderId" = $1
    `,
    [
      Number(orderId),
      payload.city || null,
      payload.cityNorm || null,
      payload.fullAddress || null,
      payload.zipcode || null,
      payload.shopeeCreateTime || null,
      payload.shopeeUpdateTime || null,
      payload.state,
      payload.stateNorm,
    ],
  );
}

async function deleteOrderItemsByShopAndOrder(shopId, orderId) {
  await query(
    `
      DELETE FROM "OrderItem"
      WHERE "shopId" = $1
        AND "orderId" = $2
    `,
    [Number(shopId), Number(orderId)],
  );
}

async function listLocalProductsByItemIds(shopId, itemIds = []) {
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
      SELECT id, "itemId" AS item_id
      FROM "Product"
      WHERE "shopId" = $1
        AND "itemId" = ANY($2::bigint[])
    `,
    [Number(shopId), normalizedItemIds],
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    itemId: row.item_id == null ? null : BigInt(row.item_id),
  }));
}

async function createOrderItems(rows = []) {
  if (!Array.isArray(rows) || !rows.length) {
    return;
  }

  const values = [];
  const tuples = rows.map((row) => {
    values.push(
      Number(row.shopId),
      Number(row.orderId),
      row.productId == null ? null : Number(row.productId),
      row.itemId == null ? null : toBigIntString(row.itemId),
      row.modelId == null ? null : toBigIntString(row.modelId),
      row.itemSku || null,
      row.itemName || null,
      row.quantity == null ? null : Number(row.quantity),
      row.orderPrice == null ? null : Number(row.orderPrice),
    );
    const base = values.length - 8;
    return `($${base}::int, $${base + 1}::int, $${base + 2}, $${base + 3}::bigint, $${base + 4}::bigint, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, NOW(), NOW())`;
  });

  await query(
    `
      INSERT INTO "OrderItem" (
        "shopId",
        "orderId",
        "productId",
        "itemId",
        "modelId",
        "itemSku",
        "itemName",
        quantity,
        "orderPrice",
        "createdAt",
        "updatedAt"
      )
      VALUES ${tuples.join(", ")}
    `,
    values,
  );
}

async function deleteOrderByShopAndOrderSn(shopId, orderSn) {
  await query(
    `
      DELETE FROM "Order"
      WHERE "shopId" = $1
        AND "orderSn" = $2
    `,
    [Number(shopId), String(orderSn || "")],
  );
}

async function listExistingOrdersByShopAndOrderSns(shopId, orderSns = []) {
  const normalized = Array.from(
    new Set(
      (Array.isArray(orderSns) ? orderSns : [])
        .map((orderSn) => String(orderSn || "").trim())
        .filter(Boolean),
    ),
  );

  if (!normalized.length) return [];

  const result = await query(
    `
      SELECT
        id,
        "orderSn" AS order_sn,
        "orderStatus" AS order_status,
        "orderId" AS order_id,
        "shipByDate" AS ship_by_date,
        "shopeeCreateTime" AS shopee_create_time,
        "shopeeUpdateTime" AS shopee_update_time
      FROM "Order"
      WHERE "shopId" = $1
        AND "orderSn" = ANY($2::text[])
    `,
    [Number(shopId), normalized],
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    orderSn: row.order_sn,
    orderId: row.order_id == null ? null : BigInt(row.order_id),
    orderStatus: row.order_status || null,
    shipByDate: row.ship_by_date || null,
    shopeeCreateTime: row.shopee_create_time || null,
    shopeeUpdateTime: row.shopee_update_time || null,
  }));
}

async function updateExistingOrderCoreByShopAndOrderSn(shopId, orderSn, payload) {
  await ensureOrderPackageColumns();
  const row = await queryOne(
    `
      UPDATE "Order"
      SET
        "orderStatus" = COALESCE($3::text, "orderStatus"),
        "orderId" = COALESCE($4::bigint, "orderId"),
        "daysToShip" = COALESCE($5::int, "daysToShip"),
        "shipByDate" = COALESCE($6::timestamptz, "shipByDate"),
        "shopeeUpdateTime" = COALESCE($7::timestamptz, "shopeeUpdateTime"),
        "shippingCarrier" = COALESCE($8::text, "shippingCarrier"),
        "packageNumber" = COALESCE($9::text, "packageNumber"),
        "packageFulfillmentStatus" = COALESCE($10::text, "packageFulfillmentStatus"),
        "packageLogisticsChannelId" = COALESCE($11::bigint, "packageLogisticsChannelId"),
        "packageTrackingNumber" = COALESCE($12::text, "packageTrackingNumber"),
        "packageShipByDate" = COALESCE($13::timestamptz, "packageShipByDate"),
        "packagePickupDoneTime" = COALESCE($14::timestamptz, "packagePickupDoneTime"),
        "estimatedDeliveryTime" = COALESCE($15::timestamptz, "estimatedDeliveryTime"),
        "estimatedDeliveryStartTime" = COALESCE($16::timestamptz, "estimatedDeliveryStartTime"),
        "estimatedDeliveryEndTime" = COALESCE($17::timestamptz, "estimatedDeliveryEndTime"),
        "preparationEndTime" = COALESCE($18::timestamptz, "preparationEndTime"),
        "driverEtaStartTime" = COALESCE($19::timestamptz, "driverEtaStartTime"),
        "driverEtaEndTime" = COALESCE($20::timestamptz, "driverEtaEndTime"),
        "packageDetailRaw" = COALESCE($21::jsonb, "packageDetailRaw"),
        "updatedAt" = NOW()
      WHERE "shopId" = $1
        AND "orderSn" = $2
      RETURNING
        id,
        "orderSn" AS order_sn,
        "orderId" AS order_id,
        "orderStatus" AS order_status,
        "shipByDate" AS ship_by_date,
        "shopeeCreateTime" AS shopee_create_time,
        "shopeeUpdateTime" AS shopee_update_time
    `,
    [
      Number(shopId),
      String(orderSn || "").trim(),
      payload?.orderStatus || null,
      payload?.orderId == null ? null : toBigIntString(payload.orderId),
      payload?.daysToShip ?? null,
      payload?.shipByDate || null,
      payload?.shopeeUpdateTime || null,
      payload?.shippingCarrier || null,
      payload?.packageNumber || null,
      payload?.packageFulfillmentStatus || null,
      payload?.packageLogisticsChannelId ?? null,
      payload?.packageTrackingNumber || null,
      payload?.packageShipByDate || null,
      payload?.packagePickupDoneTime || null,
      payload?.estimatedDeliveryTime || null,
      payload?.estimatedDeliveryStartTime || null,
      payload?.estimatedDeliveryEndTime || null,
      payload?.preparationEndTime || null,
      payload?.driverEtaStartTime || null,
      payload?.driverEtaEndTime || null,
      payload?.packageDetailRaw ? JSON.stringify(payload.packageDetailRaw) : null,
    ],
  );

  return row
    ? {
        id: Number(row.id),
        orderSn: row.order_sn,
        orderId: row.order_id == null ? null : BigInt(row.order_id),
        orderStatus: row.order_status || null,
        shipByDate: row.ship_by_date || null,
        shopeeCreateTime: row.shopee_create_time || null,
        shopeeUpdateTime: row.shopee_update_time || null,
      }
    : null;
}

async function upsertOrderByShopAndOrderSn(shopId, orderSn, payload) {
  const normalizedOrderSn = String(orderSn || "").trim();
  if (!normalizedOrderSn) {
    throw new Error("order_sn ausente para upsert de pedido.");
  }

  await ensureOrderPackageColumns();
  const { hasOrderNumber } = await getOrderTableCapabilities();
  const insertColumns = [
    `"shopId"`,
    `"orderSn"`,
    `"orderId"`,
    ...(hasOrderNumber ? [`"orderNumber"`] : []),
    `"orderStatus"`,
    `region`,
    `currency`,
    `"daysToShip"`,
    `"shipByDate"`,
    `"gmvCents"`,
    `"shopeeCreateTime"`,
    `"shopeeUpdateTime"`,
    `"bookingSn"`,
    `cod`,
    `"advancePackage"`,
    `"hotListingOrder"`,
    `"isBuyerShopCollection"`,
    `"messageToSeller"`,
    `"reverseShippingFee"`,
    `"itemsSubtotalCents"`,
    `"shippingCents"`,
    `"estimatedShippingFeeCents"`,
    `"actualShippingFeeCents"`,
    `"totalAmountCents"`,
    `"shippingCarrier"`,
    `"paymentMethod"`,
    `"packageNumber"`,
    `"packageFulfillmentStatus"`,
    `"packageLogisticsChannelId"`,
    `"packageTrackingNumber"`,
    `"packageShipByDate"`,
    `"packagePickupDoneTime"`,
    `"estimatedDeliveryTime"`,
    `"estimatedDeliveryStartTime"`,
    `"estimatedDeliveryEndTime"`,
    `"preparationEndTime"`,
    `"driverEtaStartTime"`,
    `"driverEtaEndTime"`,
    `"packageDetailRaw"`,
    `"createdAt"`,
    `"updatedAt"`,
  ];

  const values = [
    Number(shopId),
    normalizedOrderSn,
    payload.orderId == null ? null : toBigIntString(payload.orderId),
    ...(hasOrderNumber ? [normalizedOrderSn] : []),
    payload.orderStatus || null,
    payload.region || null,
    payload.currency || null,
    payload.daysToShip ?? null,
    payload.shipByDate || null,
    payload.gmvCents ?? 0,
    payload.shopeeCreateTime || null,
    payload.shopeeUpdateTime || null,
    payload.bookingSn || null,
    payload.cod ?? null,
    payload.advancePackage ?? null,
    payload.hotListingOrder ?? null,
    payload.isBuyerShopCollection ?? null,
    payload.messageToSeller || null,
    payload.reverseShippingFee ?? null,
    payload.itemsSubtotalCents ?? null,
    payload.shippingCents ?? null,
    payload.estimatedShippingFeeCents ?? 0,
    payload.actualShippingFeeCents ?? 0,
    payload.totalAmountCents ?? payload.gmvCents ?? 0,
    payload.shippingCarrier || null,
    payload.paymentMethod || null,
    payload.packageNumber || null,
    payload.packageFulfillmentStatus || null,
    payload.packageLogisticsChannelId ?? null,
    payload.packageTrackingNumber || null,
    payload.packageShipByDate || null,
    payload.packagePickupDoneTime || null,
    payload.estimatedDeliveryTime || null,
    payload.estimatedDeliveryStartTime || null,
    payload.estimatedDeliveryEndTime || null,
    payload.preparationEndTime || null,
    payload.driverEtaStartTime || null,
    payload.driverEtaEndTime || null,
    payload.packageDetailRaw ? JSON.stringify(payload.packageDetailRaw) : null,
  ];

  const insertValuesSql = values
    .map((_, index) =>
      insertColumns[index] === `"packageDetailRaw"`
        ? `$${index + 1}::jsonb`
        : `$${index + 1}`,
    )
    .join(", ");
  const updateAssignments = [
    `"orderStatus" = EXCLUDED."orderStatus"`,
    `"orderId" = COALESCE(EXCLUDED."orderId", "Order"."orderId")`,
    `region = EXCLUDED.region`,
    `currency = EXCLUDED.currency`,
    `"daysToShip" = EXCLUDED."daysToShip"`,
    `"shipByDate" = EXCLUDED."shipByDate"`,
    `"gmvCents" = EXCLUDED."gmvCents"`,
    `"shopeeCreateTime" = EXCLUDED."shopeeCreateTime"`,
    `"shopeeUpdateTime" = EXCLUDED."shopeeUpdateTime"`,
    `"bookingSn" = EXCLUDED."bookingSn"`,
    `cod = EXCLUDED.cod`,
    `"advancePackage" = EXCLUDED."advancePackage"`,
    `"hotListingOrder" = EXCLUDED."hotListingOrder"`,
    `"isBuyerShopCollection" = EXCLUDED."isBuyerShopCollection"`,
    `"messageToSeller" = EXCLUDED."messageToSeller"`,
    `"reverseShippingFee" = EXCLUDED."reverseShippingFee"`,
    `"itemsSubtotalCents" = EXCLUDED."itemsSubtotalCents"`,
    `"shippingCents" = EXCLUDED."shippingCents"`,
    `"estimatedShippingFeeCents" = EXCLUDED."estimatedShippingFeeCents"`,
    `"actualShippingFeeCents" = EXCLUDED."actualShippingFeeCents"`,
    `"totalAmountCents" = EXCLUDED."totalAmountCents"`,
    `"shippingCarrier" = EXCLUDED."shippingCarrier"`,
    `"paymentMethod" = EXCLUDED."paymentMethod"`,
    `"packageNumber" = EXCLUDED."packageNumber"`,
    `"packageFulfillmentStatus" = EXCLUDED."packageFulfillmentStatus"`,
    `"packageLogisticsChannelId" = EXCLUDED."packageLogisticsChannelId"`,
    `"packageTrackingNumber" = EXCLUDED."packageTrackingNumber"`,
    `"packageShipByDate" = EXCLUDED."packageShipByDate"`,
    `"packagePickupDoneTime" = EXCLUDED."packagePickupDoneTime"`,
    `"estimatedDeliveryTime" = EXCLUDED."estimatedDeliveryTime"`,
    `"estimatedDeliveryStartTime" = EXCLUDED."estimatedDeliveryStartTime"`,
    `"estimatedDeliveryEndTime" = EXCLUDED."estimatedDeliveryEndTime"`,
    `"preparationEndTime" = EXCLUDED."preparationEndTime"`,
    `"driverEtaStartTime" = EXCLUDED."driverEtaStartTime"`,
    `"driverEtaEndTime" = EXCLUDED."driverEtaEndTime"`,
    `"packageDetailRaw" = EXCLUDED."packageDetailRaw"`,
    ...(hasOrderNumber ? [`"orderNumber" = EXCLUDED."orderNumber"`] : []),
    `"updatedAt" = NOW()`,
  ];

  const row = await queryOne(
    `
      INSERT INTO "Order" (
        ${insertColumns.join(",\n        ")}
      )
      VALUES (
        ${insertValuesSql}, NOW(), NOW()
      )
      ON CONFLICT ("shopId", "orderSn")
      DO UPDATE SET
        ${updateAssignments.join(",\n        ")}
      RETURNING
        id,
        "orderSn" AS order_sn,
        "orderId" AS order_id,
        "orderStatus" AS order_status,
        "shipByDate" AS ship_by_date,
        "shopeeCreateTime" AS shopee_create_time,
        "shopeeUpdateTime" AS shopee_update_time,
        "itemsSubtotalCents" AS items_subtotal_cents,
        "gmvCents" AS gmv_cents
    `,
    values,
  );

  return row
    ? {
        id: Number(row.id),
        orderSn: row.order_sn,
        orderId: row.order_id == null ? null : BigInt(row.order_id),
        orderStatus: row.order_status || null,
        shipByDate: row.ship_by_date || null,
        shopeeCreateTime: row.shopee_create_time || null,
        shopeeUpdateTime: row.shopee_update_time || null,
        itemsSubtotalCents:
          row.items_subtotal_cents == null
            ? null
            : Number(row.items_subtotal_cents),
        gmvCents: Number(row.gmv_cents || 0),
      }
    : null;
}

async function resolvePendingOrderAddressAlerts(orderId) {
  await query(
    `
      UPDATE "OrderAddressChangeAlert"
      SET status = 'RESOLVED', "updatedAt" = NOW()
      WHERE "orderId" = $1
        AND status = 'PENDING'
    `,
    [Number(orderId)],
  );
}

async function findLatestOrderAddressSnapshot(orderId) {
  const row = await queryOne(
    `
      SELECT
        id,
        "addressHash" AS address_hash,
        zipcode,
        state,
        city,
        "fullAddress" AS full_address
      FROM "OrderAddressSnapshot"
      WHERE "orderId" = $1
      ORDER BY "createdAt" DESC, id DESC
      LIMIT 1
    `,
    [Number(orderId)],
  );

  return row
    ? {
        id: Number(row.id),
        addressHash: row.address_hash,
        zipcode: row.zipcode || null,
        state: row.state || null,
        city: row.city || null,
        fullAddress: row.full_address || null,
      }
    : null;
}

async function updateOrderAddressSnapshotHash(snapshotId, addressHash) {
  await query(
    `
      UPDATE "OrderAddressSnapshot"
      SET "addressHash" = $2
      WHERE id = $1
    `,
    [Number(snapshotId), addressHash],
  );
}

async function createOrderAddressSnapshot(payload) {
  const row = await queryOne(
    `
      INSERT INTO "OrderAddressSnapshot" (
        "orderId",
        name,
        phone,
        town,
        district,
        city,
        state,
        region,
        zipcode,
        "fullAddress",
        "addressHash"
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id
    `,
    [
      Number(payload.orderId),
      payload.name || null,
      payload.phone || null,
      payload.town || null,
      payload.district || null,
      payload.city || null,
      payload.state || null,
      payload.region || null,
      payload.zipcode || null,
      payload.fullAddress || null,
      payload.addressHash,
    ],
  );

  return row ? { id: Number(row.id) } : null;
}

async function upsertOrderAddressChangeAlert(orderId, newHash, payload) {
  await query(
    `
      INSERT INTO "OrderAddressChangeAlert" (
        "orderId",
        "oldSnapshotId",
        "newSnapshotId",
        "oldHash",
        "newHash",
        status,
        "updatedAt"
      )
      VALUES ($1, $2, $3, $4, $5, 'PENDING', NOW())
      ON CONFLICT ("orderId", "newHash")
      DO UPDATE SET
        status = 'PENDING',
        "oldSnapshotId" = EXCLUDED."oldSnapshotId",
        "newSnapshotId" = EXCLUDED."newSnapshotId",
        "oldHash" = EXCLUDED."oldHash",
        "updatedAt" = NOW()
    `,
    [
      Number(orderId),
      payload.oldSnapshotId == null ? null : Number(payload.oldSnapshotId),
      Number(payload.newSnapshotId),
      payload.oldHash || null,
      newHash,
    ],
  );
}

async function updateOrderIncomeByOrderSn(shopId, orderSn, payload) {
  await query(
    `
      UPDATE "Order"
      SET
        "incomeSyncedAt" = $3,
        "incomeStatus" = $4,
        "incomeNetCents" = $5,
        "incomeDetailRaw" = $6::jsonb,
        "finCommissionCents" = $7,
        "finServiceFeeCents" = $8,
        "finTransactionFeeCents" = $9,
        "finShippingFeeCents" = $10,
        "finVoucherSellerCents" = $11,
        "finVoucherShopeeCents" = $12,
        "finShopeeDiscountCents" = $13,
        "finDiscountFromCoinCents" = $14,
        "finDiscountVoucherShopeeCents" = $15,
        "finDiscountVoucherSellerCents" = $16,
        "updatedAt" = NOW()
      WHERE "shopId" = $1
        AND "orderSn" = $2
    `,
    [
      Number(shopId),
      String(orderSn),
      payload.incomeSyncedAt || new Date(),
      payload.incomeStatus || null,
      payload.incomeNetCents ?? null,
      JSON.stringify(payload.incomeDetailRaw || {}),
      payload.finCommissionCents ?? 0,
      payload.finServiceFeeCents ?? 0,
      payload.finTransactionFeeCents ?? 0,
      payload.finShippingFeeCents ?? 0,
      payload.finVoucherSellerCents ?? 0,
      payload.finVoucherShopeeCents ?? 0,
      payload.finShopeeDiscountCents ?? 0,
      payload.finDiscountFromCoinCents ?? 0,
      payload.finDiscountVoucherShopeeCents ?? 0,
      payload.finDiscountVoucherSellerCents ?? 0,
    ],
  );
}

module.exports = {
  ensureOrderPackageColumns,
  createOrderAddressSnapshot,
  createOrderGeoAddress,
  createOrderItems,
  deleteOrderByShopAndOrderSn,
  deleteOrderItemsByShopAndOrder,
  listExistingOrdersByShopAndOrderSns,
  findLatestOrderAddressSnapshot,
  findOrderGeoAddressSummary,
  findShopByShopeeShopId,
  listLocalProductsByItemIds,
  resolvePendingOrderAddressAlerts,
  updateExistingOrderCoreByShopAndOrderSn,
  updateOrderAddressSnapshotHash,
  updateOrderGeoAddressByOrderId,
  updateOrderIncomeByOrderSn,
  upsertOrderAddressChangeAlert,
  upsertOrderByShopAndOrderSn,
};
