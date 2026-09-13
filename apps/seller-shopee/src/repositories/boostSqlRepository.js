"use strict";

const { query, queryOne, withClient } = require("../config/postgres");

const PAID_EXCLUDED_STATUSES = ["CANCELLED", "UNPAID", "TO_RETURN", "IN_CANCEL"];

function toBigIntStringOrNull(value) {
  if (value == null || value === "") return null;
  try {
    return BigInt(value).toString();
  } catch (_error) {
    return null;
  }
}

function toIntOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function normalizeItemIds(itemIds = []) {
  return Array.from(
    new Set(
      (Array.isArray(itemIds) ? itemIds : [])
        .map((itemId) => toBigIntStringOrNull(itemId))
        .filter(Boolean),
    ),
  );
}

function mapBatchRow(row) {
  if (!row) return null;

  return {
    id: toIntOrNull(row.id),
    shopId: toIntOrNull(row.shopId),
    userId: toIntOrNull(row.userId),
    source: row.source || "manual",
    requestedItemIds: Array.isArray(row.requestedItemIds)
      ? row.requestedItemIds.map((itemId) => String(itemId))
      : [],
    successCount: Number(row.successCount || 0),
    failureCount: Number(row.failureCount || 0),
    requestId: row.requestId || null,
    warning: row.warning || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapBatchItemRow(row) {
  if (!row) return null;

  return {
    id: toIntOrNull(row.id),
    batchId: toIntOrNull(row.batchId),
    shopId: toIntOrNull(row.shopId),
    itemId: toBigIntStringOrNull(row.itemId),
    success: Boolean(row.success),
    failedReason: row.failedReason || null,
    coolDownSecondSnapshot:
      row.coolDownSecondSnapshot == null ? null : Number(row.coolDownSecondSnapshot),
    boostStartedAt: row.boostStartedAt,
    boostWindowEndsAt: row.boostWindowEndsAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    product: {
      title: row.productTitle || null,
      imageUrl: row.imageUrl || null,
    },
  };
}

async function createProductBoostBatch({
  shopId,
  userId = null,
  requestedItemIds = [],
  requestId = null,
  warning = null,
  source = "manual",
  successItemIds = [],
  failureList = [],
}) {
  const normalizedRequestedItemIds = normalizeItemIds(requestedItemIds);
  const normalizedSuccessItemIds = new Set(normalizeItemIds(successItemIds));
  const failureMap = new Map(
    (Array.isArray(failureList) ? failureList : [])
      .map((entry) => {
        const itemId = toBigIntStringOrNull(entry?.item_id ?? entry?.itemId);
        if (!itemId) return null;
        return [itemId, String(entry?.failed_reason || entry?.failedReason || "").trim() || null];
      })
      .filter(Boolean),
  );

  return withClient(async (client) => {
    await client.query("BEGIN");

    try {
      const batchResult = await client.query(
        `
          INSERT INTO "ProductBoostBatch" (
            "shopId",
            "userId",
            source,
            "requestedItemIds",
            "successCount",
            "failureCount",
            "requestId",
            warning
          )
          VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
          RETURNING
            id,
            "shopId",
            "userId",
            source,
            "requestedItemIds",
            "successCount",
            "failureCount",
            "requestId",
            warning,
            "createdAt",
            "updatedAt"
        `,
        [
          Number(shopId),
          toIntOrNull(userId),
          String(source || "manual"),
          JSON.stringify(normalizedRequestedItemIds),
          normalizedSuccessItemIds.size,
          failureMap.size,
          requestId || null,
          warning || null,
        ],
      );

      const batch = mapBatchRow(batchResult.rows[0]);

      for (const itemId of normalizedRequestedItemIds) {
        const success = normalizedSuccessItemIds.has(itemId);
        await client.query(
          `
            INSERT INTO "ProductBoostBatchItem" (
              "batchId",
              "shopId",
              "itemId",
              success,
              "failedReason",
              "boostStartedAt",
              "boostWindowEndsAt"
            )
            VALUES (
              $1,
              $2,
              $3::bigint,
              $4,
              $5,
              NOW(),
              CASE WHEN $4 THEN NOW() + INTERVAL '4 hours' ELSE NULL END
            )
          `,
          [
            Number(batch.id),
            Number(shopId),
            itemId,
            success,
            success ? null : failureMap.get(itemId) || null,
          ],
        );
      }

      await client.query("COMMIT");
      return batch;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

async function listProductBoostBatches(shopId, { limit = 40 } = {}) {
  const batchResult = await query(
    `
      SELECT
        id,
        "shopId",
        "userId",
        source,
        "requestedItemIds",
        "successCount",
        "failureCount",
        "requestId",
        warning,
        "createdAt",
        "updatedAt"
      FROM "ProductBoostBatch"
      WHERE "shopId"::text = $1::text
      ORDER BY "createdAt" DESC, id DESC
      LIMIT $2
    `,
    [Number(shopId), Number(limit)],
  );

  const batches = batchResult.rows.map(mapBatchRow);
  if (!batches.length) return [];

  const batchIds = batches.map((batch) => batch.id);
  const itemsResult = await query(
    `
      SELECT
        bi.id,
        bi."batchId",
        bi."shopId",
        bi."itemId",
        bi.success,
        bi."failedReason",
        bi."coolDownSecondSnapshot",
        bi."boostStartedAt",
        bi."boostWindowEndsAt",
        bi."createdAt",
        bi."updatedAt",
        p.title AS "productTitle",
        img.url AS "imageUrl"
      FROM "ProductBoostBatchItem" bi
      LEFT JOIN "Product" p
        ON p."shopId"::text = bi."shopId"::text
       AND p."itemId"::text = bi."itemId"::text
      LEFT JOIN LATERAL (
        SELECT pi.url
        FROM "ProductImage" pi
        WHERE pi."productId"::text = p.id::text
        ORDER BY pi.id ASC
        LIMIT 1
      ) img ON TRUE
      WHERE bi."batchId"::text = ANY($1::text[])
      ORDER BY bi."batchId" DESC, bi.id ASC
    `,
    [batchIds.map((batchId) => String(batchId))],
  );

  const itemsByBatchId = new Map();
  itemsResult.rows.map(mapBatchItemRow).forEach((item) => {
    if (!itemsByBatchId.has(item.batchId)) itemsByBatchId.set(item.batchId, []);
    itemsByBatchId.get(item.batchId).push(item);
  });

  return batches.map((batch) => ({
    ...batch,
    items: itemsByBatchId.get(batch.id) || [],
  }));
}

async function listLatestSuccessfulBoostItemIds(shopId) {
  const row = await queryOne(
    `
      SELECT b.id
      FROM "ProductBoostBatch" b
      WHERE b."shopId"::text = $1::text
        AND b."successCount" > 0
      ORDER BY b."createdAt" DESC, b.id DESC
      LIMIT 1
    `,
    [Number(shopId)],
  );

  if (!row?.id) return [];

  const itemsResult = await query(
    `
      SELECT "itemId"
      FROM "ProductBoostBatchItem"
      WHERE "batchId"::text = $1::text
        AND success = TRUE
      ORDER BY id ASC
    `,
    [Number(row.id)],
  );

  return itemsResult.rows
    .map((item) => toBigIntStringOrNull(item.itemId))
    .filter(Boolean);
}

async function listSuccessfulBoostWindows(shopId, { start = null, end = null } = {}) {
  const clauses = [`bi."shopId"::text = $1::text`, `bi.success = TRUE`];
  const params = [Number(shopId)];

  if (start) {
    params.push(start);
    clauses.push(`bi."boostStartedAt" >= $${params.length}`);
  }

  if (end) {
    params.push(end);
    clauses.push(`bi."boostStartedAt" <= $${params.length}`);
  }

  const result = await query(
    `
      SELECT
        bi.id,
        bi."batchId",
        bi."shopId",
        bi."itemId",
        bi.success,
        bi."failedReason",
        bi."coolDownSecondSnapshot",
        bi."boostStartedAt",
        bi."boostWindowEndsAt",
        bi."createdAt",
        bi."updatedAt",
        p.title AS "productTitle",
        img.url AS "imageUrl"
      FROM "ProductBoostBatchItem" bi
      LEFT JOIN "Product" p
        ON p."shopId"::text = bi."shopId"::text
       AND p."itemId"::text = bi."itemId"::text
      LEFT JOIN LATERAL (
        SELECT pi.url
        FROM "ProductImage" pi
        WHERE pi."productId"::text = p.id::text
        ORDER BY pi.id ASC
        LIMIT 1
      ) img ON TRUE
      WHERE ${clauses.join("\n        AND ")}
      ORDER BY bi."boostStartedAt" DESC, bi.id DESC
    `,
    params,
  );

  return result.rows.map(mapBatchItemRow);
}

async function listOrderEventsForBoostAnalytics(shopId, itemIds, { start, end }) {
  const normalizedItemIds = normalizeItemIds(itemIds);
  if (!normalizedItemIds.length) return [];

  const result = await query(
    `
      SELECT
        oi."itemId" AS item_id,
        oi."orderId" AS order_id,
        oi.quantity,
        COALESCE(NULLIF(oi."orderPrice"::text, '')::numeric, 0)::bigint AS gmv_cents,
        o."orderStatus" AS order_status,
        COALESCE(o."shopeeCreateTime", o."createdAt") AS sold_at
      FROM "OrderItem" oi
      INNER JOIN "Order" o ON o.id::text = oi."orderId"::text
      WHERE oi."shopId"::text = $1::text
        AND oi."itemId"::text = ANY($2::text[])
        AND o."orderStatus" IS NOT NULL
        AND o."orderStatus" <> ALL($5::text[])
        AND COALESCE(o."shopeeCreateTime", o."createdAt") >= $3
        AND COALESCE(o."shopeeCreateTime", o."createdAt") <= $4
      ORDER BY sold_at DESC, oi.id DESC
    `,
    [Number(shopId), normalizedItemIds, start, end, PAID_EXCLUDED_STATUSES],
  );

  return result.rows.map((row) => ({
    itemId: toBigIntStringOrNull(row.item_id),
    orderId: Number(row.order_id),
    quantity: Number(row.quantity || 0),
    gmvCents: Number(row.gmv_cents || 0),
    orderStatus: row.order_status || null,
    soldAt: row.sold_at,
  }));
}

async function listAdsHourlyEventsForBoostAnalytics(shopId, itemIds, { dateFrom, dateTo }) {
  const normalizedItemIds = normalizeItemIds(itemIds);
  if (!normalizedItemIds.length) return [];

  const result = await query(
    `
      SELECT
        "itemId" AS item_id,
        date,
        hour,
        impression,
        click,
        expense,
        "directGmv" AS direct_gmv,
        "broadGmv" AS broad_gmv
      FROM "AdsHourlyMetric"
      WHERE "shopId"::text = $1::text
        AND "itemId"::text = ANY($2::text[])
        AND date >= $3
        AND date <= $4
      ORDER BY date DESC, hour DESC
    `,
    [Number(shopId), normalizedItemIds, dateFrom, dateTo],
  );

  return result.rows.map((row) => ({
    itemId: toBigIntStringOrNull(row.item_id),
    date: row.date,
    hour: Number(row.hour || 0),
    impression: Number(row.impression || 0),
    click: Number(row.click || 0),
    expense: Number(row.expense || 0),
    directGmv: Number(row.direct_gmv || 0),
    broadGmv: Number(row.broad_gmv || 0),
  }));
}

module.exports = {
  createProductBoostBatch,
  listAdsHourlyEventsForBoostAnalytics,
  listLatestSuccessfulBoostItemIds,
  listOrderEventsForBoostAnalytics,
  listProductBoostBatches,
  listSuccessfulBoostWindows,
};
