"use strict";

const { query, queryOne, withClient } = require("../config/postgres");

function mapListAlertRow(row) {
  return {
    id: Number(row.id),
    createdAt: row.createdAt,
    order: {
      orderSn: row.orderSn,
      orderStatus: row.orderStatus,
      shopeeUpdateTime: row.shopeeUpdateTime,
      shipByDate: row.shipByDate,
    },
  };
}

function mapSnapshot(row, prefix) {
  if (!row) {
    return null;
  }

  const value = {
    name: row[`${prefix}Name`] || null,
    phone: row[`${prefix}Phone`] || null,
    city: row[`${prefix}City`] || null,
    state: row[`${prefix}State`] || null,
    district: row[`${prefix}District`] || null,
    town: row[`${prefix}Town`] || null,
    zipcode: row[`${prefix}Zipcode`] || null,
    region: row[`${prefix}Region`] || null,
    fullAddress: row[`${prefix}FullAddress`] || null,
    createdAt: row[`${prefix}CreatedAt`] || null,
  };

  const hasContent = Object.values(value).some((item) => item != null);
  return hasContent ? value : null;
}

function mapOrderAlertDetailRow(row) {
  return {
    id: Number(row.id),
    createdAt: row.createdAt,
    oldSnapshot: mapSnapshot(row, "oldSnapshot"),
    newSnapshot: mapSnapshot(row, "newSnapshot"),
  };
}

async function listOpenAddressAlertsForShop(shopId, limit) {
  const result = await query(
    `
      SELECT
        a.id,
        a."createdAt",
        o."orderSn",
        o."orderStatus",
        o."shopeeUpdateTime",
        o."shipByDate"
      FROM "OrderAddressChangeAlert" a
      INNER JOIN "Order" o ON o.id = a."orderId"
      WHERE a.status = 'PENDING'
        AND o."shopId" = $1
        AND o."orderStatus" = 'READY_TO_SHIP'
      ORDER BY a."createdAt" DESC
      LIMIT $2
    `,
    [shopId, limit],
  );

  return result.rows.map(mapListAlertRow);
}

async function findOrderByShopIdAndOrderSn(shopId, orderSn) {
  const row = await queryOne(
    `
      SELECT id
      FROM "Order"
      WHERE "shopId" = $1
        AND "orderSn" = $2
      LIMIT 1
    `,
    [shopId, orderSn],
  );

  return row
    ? {
        id: Number(row.id),
      }
    : null;
}

async function listOpenAddressAlertsByOrderId(orderId, limit = 10) {
  const result = await query(
    `
      SELECT
        a.id,
        a."createdAt",
        old_snap.name AS "oldSnapshotName",
        old_snap.phone AS "oldSnapshotPhone",
        old_snap.city AS "oldSnapshotCity",
        old_snap.state AS "oldSnapshotState",
        old_snap.district AS "oldSnapshotDistrict",
        old_snap.town AS "oldSnapshotTown",
        old_snap.zipcode AS "oldSnapshotZipcode",
        old_snap.region AS "oldSnapshotRegion",
        old_snap."fullAddress" AS "oldSnapshotFullAddress",
        old_snap."createdAt" AS "oldSnapshotCreatedAt",
        new_snap.name AS "newSnapshotName",
        new_snap.phone AS "newSnapshotPhone",
        new_snap.city AS "newSnapshotCity",
        new_snap.state AS "newSnapshotState",
        new_snap.district AS "newSnapshotDistrict",
        new_snap.town AS "newSnapshotTown",
        new_snap.zipcode AS "newSnapshotZipcode",
        new_snap.region AS "newSnapshotRegion",
        new_snap."fullAddress" AS "newSnapshotFullAddress",
        new_snap."createdAt" AS "newSnapshotCreatedAt"
      FROM "OrderAddressChangeAlert" a
      INNER JOIN "Order" o ON o.id = a."orderId"
      LEFT JOIN "OrderAddressSnapshot" old_snap ON old_snap.id = a."oldSnapshotId"
      INNER JOIN "OrderAddressSnapshot" new_snap ON new_snap.id = a."newSnapshotId"
      WHERE a."orderId" = $1
        AND a.status = 'PENDING'
        AND o."orderStatus" = 'READY_TO_SHIP'
      ORDER BY a."createdAt" DESC
      LIMIT $2
    `,
    [orderId, limit],
  );

  return result.rows.map(mapOrderAlertDetailRow);
}

async function findAddressAlertSummaryByIdAndShopId(alertId, shopId) {
  const row = await queryOne(
    `
      SELECT
        a.id,
        a.status
      FROM "OrderAddressChangeAlert" a
      INNER JOIN "Order" o ON o.id = a."orderId"
      WHERE a.id = $1
        AND o."shopId" = $2
      LIMIT 1
    `,
    [alertId, shopId],
  );

  return row
    ? {
        id: Number(row.id),
        status: row.status,
      }
    : null;
}

async function resolveAddressAlertById(alertId) {
  const row = await queryOne(
    `
      UPDATE "OrderAddressChangeAlert"
      SET status = 'RESOLVED',
          "updatedAt" = NOW()
      WHERE id = $1
      RETURNING id
    `,
    [alertId],
  );

  return Boolean(row);
}

async function findShopNotificationContextById(shopId) {
  const row = await queryOne(
    `
      SELECT
        s.id,
        s."shopId" AS "shopShopeeId",
        a.id AS "accountId",
        a.name AS "accountName"
      FROM "Shop" s
      LEFT JOIN "Account" a ON a.id = s."accountId"
      WHERE s.id = $1
      LIMIT 1
    `,
    [Number(shopId)],
  );

  if (!row) {
    return null;
  }

  const usersResult = await query(
    `
      SELECT name, email, role, status
      FROM "User"
      WHERE "accountId" = $1
      ORDER BY id ASC
    `,
    [Number(row.accountId)],
  );

  return {
    id: Number(row.id),
    shopId: BigInt(row.shopShopeeId),
    account: row.accountId == null
      ? null
      : {
          id: Number(row.accountId),
          name: row.accountName || null,
          users: usersResult.rows.map((user) => ({
            name: user.name || null,
            email: user.email,
            role: user.role,
            status: user.status,
          })),
        },
  };
}

async function listPendingAddressAlertsForNotification(shopId) {
  const result = await query(
    `
      SELECT
        a.id,
        a."createdAt",
        o."orderSn",
        old_snap.name AS "oldSnapshotName",
        old_snap.phone AS "oldSnapshotPhone",
        old_snap.city AS "oldSnapshotCity",
        old_snap.state AS "oldSnapshotState",
        old_snap.district AS "oldSnapshotDistrict",
        old_snap.town AS "oldSnapshotTown",
        old_snap.zipcode AS "oldSnapshotZipcode",
        old_snap.region AS "oldSnapshotRegion",
        old_snap."fullAddress" AS "oldSnapshotFullAddress",
        new_snap.name AS "newSnapshotName",
        new_snap.phone AS "newSnapshotPhone",
        new_snap.city AS "newSnapshotCity",
        new_snap.state AS "newSnapshotState",
        new_snap.district AS "newSnapshotDistrict",
        new_snap.town AS "newSnapshotTown",
        new_snap.zipcode AS "newSnapshotZipcode",
        new_snap.region AS "newSnapshotRegion",
        new_snap."fullAddress" AS "newSnapshotFullAddress"
      FROM "OrderAddressChangeAlert" a
      INNER JOIN "Order" o ON o.id = a."orderId"
      LEFT JOIN "OrderAddressSnapshot" old_snap ON old_snap.id = a."oldSnapshotId"
      INNER JOIN "OrderAddressSnapshot" new_snap ON new_snap.id = a."newSnapshotId"
      WHERE a.status = 'PENDING'
        AND a."notificationSentAt" IS NULL
        AND o."shopId" = $1
      ORDER BY a."createdAt" DESC, a.id DESC
    `,
    [Number(shopId)],
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    createdAt: row.createdAt,
    order: {
      orderSn: row.orderSn,
    },
    oldSnapshot: mapSnapshot(row, "oldSnapshot"),
    newSnapshot: mapSnapshot(row, "newSnapshot"),
  }));
}

async function markAddressAlertsNotification(alertIds, data = {}) {
  const normalizedAlertIds = Array.from(
    new Set(
      (alertIds || [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  );

  if (!normalizedAlertIds.length) {
    return 0;
  }

  const params = [normalizedAlertIds];
  const sets = [];
  let nextParam = 2;

  if (Object.prototype.hasOwnProperty.call(data, "notificationAttemptedAt")) {
    sets.push(`"notificationAttemptedAt" = $${nextParam++}`);
    params.push(data.notificationAttemptedAt);
  }

  if (Object.prototype.hasOwnProperty.call(data, "notificationError")) {
    sets.push(`"notificationError" = $${nextParam++}`);
    params.push(data.notificationError);
  }

  if (Object.prototype.hasOwnProperty.call(data, "notificationSentAt")) {
    sets.push(`"notificationSentAt" = $${nextParam++}`);
    params.push(data.notificationSentAt);
  }

  if (!sets.length) {
    return 0;
  }

  sets.push(`"updatedAt" = NOW()`);

  const row = await queryOne(
    `
      UPDATE "OrderAddressChangeAlert"
      SET ${sets.join(", ")}
      WHERE id = ANY($1::int[])
      RETURNING COUNT(*) OVER()::int AS total
    `,
    params,
  );

  return Number(row?.total || 0);
}

async function resolvePendingAddressAlertsByOrderId(orderId) {
  const row = await queryOne(
    `
      UPDATE "OrderAddressChangeAlert"
      SET status = 'RESOLVED',
          "updatedAt" = NOW()
      WHERE "orderId" = $1
        AND status = 'PENDING'
      RETURNING COUNT(*) OVER()::int AS total
    `,
    [Number(orderId)],
  );

  return Number(row?.total || 0);
}

async function checkAndCreateAddressAlertSql({
  orderId,
  orderStatus,
  snapshotData,
}) {
  const status = String(orderStatus || "").toUpperCase();
  const isClosed = ["COMPLETED", "CANCELLED", "RETURNED"].includes(status);
  const shouldTrack = status === "READY_TO_SHIP";

  if (isClosed || !shouldTrack) {
    await resolvePendingAddressAlertsByOrderId(orderId);
    return { changed: false, closed: true };
  }

  return withClient(async (client) => {
    await client.query("BEGIN");

    try {
      const lastResult = await client.query(
        `
          SELECT id, "addressHash"
          FROM "OrderAddressSnapshot"
          WHERE "orderId" = $1
          ORDER BY "createdAt" DESC, id DESC
          LIMIT 1
        `,
        [Number(orderId)],
      );

      const last = lastResult.rows[0] || null;
      if (last && last.addressHash === snapshotData.addressHash) {
        await client.query("COMMIT");
        return { changed: false, closed: false };
      }

      const snapshotResult = await client.query(
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
            "addressHash",
            "createdAt"
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
          RETURNING id
        `,
        [
          Number(orderId),
          snapshotData.name || null,
          snapshotData.phone || null,
          snapshotData.town || null,
          snapshotData.district || null,
          snapshotData.city || null,
          snapshotData.state || null,
          snapshotData.region || null,
          snapshotData.zipcode || null,
          snapshotData.fullAddress || null,
          snapshotData.addressHash,
        ],
      );

      const newSnapshotId = Number(snapshotResult.rows[0].id);

      if (last) {
        await client.query(
          `
            INSERT INTO "OrderAddressChangeAlert" (
              "orderId",
              "oldSnapshotId",
              "newSnapshotId",
              "oldHash",
              "newHash",
              status,
              "createdAt",
              "updatedAt"
            )
            VALUES ($1, $2, $3, $4, $5, 'PENDING', NOW(), NOW())
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
            Number(last.id),
            newSnapshotId,
            last.addressHash,
            snapshotData.addressHash,
          ],
        );
        await client.query("COMMIT");
        return { changed: true, closed: false };
      }

      await client.query("COMMIT");
      return { changed: false, closed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

module.exports = {
  checkAndCreateAddressAlertSql,
  findAddressAlertSummaryByIdAndShopId,
  findOrderByShopIdAndOrderSn,
  findShopNotificationContextById,
  listOpenAddressAlertsByOrderId,
  listOpenAddressAlertsForShop,
  listPendingAddressAlertsForNotification,
  markAddressAlertsNotification,
  resolveAddressAlertById,
  resolvePendingAddressAlertsByOrderId,
};
