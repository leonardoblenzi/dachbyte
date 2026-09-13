"use strict";

const { query, queryOne } = require("../config/postgres");

function toBigIntStringOrNull(value) {
  if (value == null || value === "") {
    return null;
  }

  try {
    return BigInt(value).toString();
  } catch (_error) {
    return null;
  }
}

async function listAllShopsForAdsAttribution() {
  const result = await query(
    `
      SELECT id, "shopId" AS shop_id, region
      FROM "Shop"
      ORDER BY id ASC
    `,
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    shopId: row.shop_id == null ? null : BigInt(row.shop_id),
    region: row.region || null,
  }));
}

async function listEligibleOrdersForAdsAttribution(shopId, since, limit = 500) {
  const result = await query(
    `
      SELECT
        o.id,
        o."orderSn" AS order_sn,
        o."shopeeCreateTime" AS shopee_create_time,
        o."itemsSubtotalCents" AS items_subtotal_cents
      FROM "Order" o
      LEFT JOIN "OrderAdsAttribution" a ON a."orderId" = o.id
      WHERE o."shopId" = $1
        AND o."shopeeCreateTime" IS NOT NULL
        AND o."shopeeCreateTime" >= $2
        AND o."itemsSubtotalCents" IS NOT NULL
        AND a.id IS NULL
      ORDER BY o."shopeeCreateTime" ASC, o.id ASC
      LIMIT $3
    `,
    [Number(shopId), since, Number(limit)],
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    orderSn: row.order_sn,
    shopeeCreateTime: row.shopee_create_time,
    itemsSubtotalCents: Number(row.items_subtotal_cents || 0),
  }));
}

async function listAdsMetricsForAttributionRange(shopId, fromDate, toDate, type = "CPC") {
  const result = await query(
    `
      SELECT
        date,
        hour,
        type,
        "itemId" AS item_id,
        impression,
        click,
        ctr,
        expense,
        cpc,
        "directGmv" AS direct_gmv,
        "directSold" AS direct_sold,
        "directRoas" AS direct_roas,
        "broadGmv" AS broad_gmv,
        "broadSold" AS broad_sold,
        "broadRoas" AS broad_roas
      FROM "AdsHourlyMetric"
      WHERE "shopId" = $1
        AND type = $2
        AND date >= $3
        AND date <= $4
    `,
    [Number(shopId), String(type), fromDate, toDate],
  );

  return result.rows.map((row) => ({
    date: row.date,
    hour: Number(row.hour || 0),
    type: row.type || null,
    itemId: row.item_id == null ? null : BigInt(row.item_id),
    impression: Number(row.impression || 0),
    click: Number(row.click || 0),
    ctr: row.ctr == null ? 0 : Number(row.ctr),
    expense: Number(row.expense || 0),
    cpc: Number(row.cpc || 0),
    directGmv: Number(row.direct_gmv || 0),
    directSold: Number(row.direct_sold || 0),
    directRoas: row.direct_roas == null ? 0 : Number(row.direct_roas),
    broadGmv: Number(row.broad_gmv || 0),
    broadSold: Number(row.broad_sold || 0),
    broadRoas: row.broad_roas == null ? 0 : Number(row.broad_roas),
  }));
}

async function createOrderAdsAttribution({
  shopId,
  orderId,
  orderSn,
  adsType = "CPC",
  channelId = null,
  matchConfidence = "LOW",
}) {
  const row = await queryOne(
    `
      INSERT INTO "OrderAdsAttribution" (
        "shopId",
        "orderId",
        "orderSn",
        "adsType",
        "channelId",
        "matchConfidence",
        "updatedAt"
      )
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT ("orderId") DO NOTHING
      RETURNING id
    `,
    [
      Number(shopId),
      Number(orderId),
      String(orderSn || ""),
      adsType,
      channelId == null ? null : Number(channelId),
      String(matchConfidence || "LOW").toUpperCase(),
    ],
  );

  return Boolean(row);
}

async function upsertAdsHourlyMetric({
  shopId,
  date,
  hour,
  type = "CPC",
  itemId = null,
  impression = 0,
  click = 0,
  ctr = 0,
  expense = 0,
  cpc = 0,
  directGmv = 0,
  directSold = 0,
  directRoas = 0,
  broadGmv = 0,
  broadSold = 0,
  broadRoas = 0,
}) {
  const normalizedItemId = toBigIntStringOrNull(itemId);

  if (normalizedItemId == null) {
    const updated = await queryOne(
      `
        UPDATE "AdsHourlyMetric"
        SET
          impression = $5,
          click = $6,
          ctr = $7,
          expense = $8,
          cpc = $9,
          "directGmv" = $10,
          "directSold" = $11,
          "directRoas" = $12,
          "broadGmv" = $13,
          "broadSold" = $14,
          "broadRoas" = $15,
          "updatedAt" = NOW()
        WHERE "shopId" = $1
          AND date = $2
          AND hour = $3
          AND type = $4
          AND "itemId" IS NULL
        RETURNING id
      `,
      [
        Number(shopId),
        date,
        Number(hour),
        String(type),
        Number(impression || 0),
        Number(click || 0),
        Number(ctr || 0),
        Number(expense || 0),
        Number(cpc || 0),
        Number(directGmv || 0),
        Number(directSold || 0),
        Number(directRoas || 0),
        Number(broadGmv || 0),
        Number(broadSold || 0),
        Number(broadRoas || 0),
      ],
    );

    if (updated) {
      return true;
    }

    await query(
      `
        INSERT INTO "AdsHourlyMetric" (
          "shopId",
          date,
          hour,
          type,
          "itemId",
          impression,
          click,
          ctr,
          expense,
          cpc,
          "directGmv",
          "directSold",
          "directRoas",
          "broadGmv",
          "broadSold",
          "broadRoas",
          "updatedAt"
        )
        VALUES (
          $1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW()
        )
      `,
      [
        Number(shopId),
        date,
        Number(hour),
        String(type),
        Number(impression || 0),
        Number(click || 0),
        Number(ctr || 0),
        Number(expense || 0),
        Number(cpc || 0),
        Number(directGmv || 0),
        Number(directSold || 0),
        Number(directRoas || 0),
        Number(broadGmv || 0),
        Number(broadSold || 0),
        Number(broadRoas || 0),
      ],
    );

    return true;
  }

  await query(
    `
      INSERT INTO "AdsHourlyMetric" (
        "shopId",
        date,
        hour,
        type,
        "itemId",
        impression,
        click,
        ctr,
        expense,
        cpc,
        "directGmv",
        "directSold",
        "directRoas",
        "broadGmv",
        "broadSold",
        "broadRoas",
        "updatedAt"
      )
      VALUES (
        $1, $2, $3, $4, $5::bigint, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW()
      )
      ON CONFLICT ("shopId", date, hour, type, "itemId")
      DO UPDATE SET
        impression = EXCLUDED.impression,
        click = EXCLUDED.click,
        ctr = EXCLUDED.ctr,
        expense = EXCLUDED.expense,
        cpc = EXCLUDED.cpc,
        "directGmv" = EXCLUDED."directGmv",
        "directSold" = EXCLUDED."directSold",
        "directRoas" = EXCLUDED."directRoas",
        "broadGmv" = EXCLUDED."broadGmv",
        "broadSold" = EXCLUDED."broadSold",
        "broadRoas" = EXCLUDED."broadRoas",
        "updatedAt" = NOW()
    `,
    [
      Number(shopId),
      date,
      Number(hour),
      String(type),
      normalizedItemId,
      Number(impression || 0),
      Number(click || 0),
      Number(ctr || 0),
      Number(expense || 0),
      Number(cpc || 0),
      Number(directGmv || 0),
      Number(directSold || 0),
      Number(directRoas || 0),
      Number(broadGmv || 0),
      Number(broadSold || 0),
      Number(broadRoas || 0),
    ],
  );

  return true;
}

module.exports = {
  createOrderAdsAttribution,
  listAdsMetricsForAttributionRange,
  listAllShopsForAdsAttribution,
  listEligibleOrdersForAdsAttribution,
  upsertAdsHourlyMetric,
};
