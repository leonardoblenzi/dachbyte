"use strict";

const { query, queryOne } = require("../config/postgres");

function mapShopRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    shopId: row.shop_id == null ? null : BigInt(row.shop_id),
    region: row.region || null,
    status: row.status || null,
    accountId: row.account_id == null ? null : Number(row.account_id),
    taxRate: row.tax_rate == null ? 0 : Number(row.tax_rate),
  };
}

async function findShopByDbIdAndAccountId(shopDbId, accountId) {
  const row = await queryOne(
    `
      SELECT
        id,
        "shopId" AS shop_id,
        region,
        status,
        "accountId" AS account_id,
        "taxRate" AS tax_rate
      FROM "Shop"
      WHERE id = $1
        AND "accountId" = $2
      LIMIT 1
    `,
    [shopDbId, accountId],
  );

  return mapShopRow(row);
}

async function findShopByDbIdOrShopeeShopId(shopId) {
  const raw = String(shopId || "").trim();
  if (!raw) return null;

  let row = null;
  const dbId = Number(raw);
  if (Number.isInteger(dbId)) {
    row = await queryOne(
      `
        SELECT
          id,
          "shopId" AS shop_id,
          region,
          status,
          "accountId" AS account_id,
          "taxRate" AS tax_rate
        FROM "Shop"
        WHERE id = $1
        LIMIT 1
      `,
      [dbId],
    );
  }

  if (!row) {
    try {
      const shopeeShopId = BigInt(raw);
      row = await queryOne(
        `
          SELECT
            id,
            "shopId" AS shop_id,
            region,
            status,
            "accountId" AS account_id,
            "taxRate" AS tax_rate
          FROM "Shop"
          WHERE "shopId" = $1
          LIMIT 1
        `,
        [shopeeShopId.toString()],
      );
    } catch (_error) {
      return null;
    }
  }

  return mapShopRow(row);
}

async function listShopsWithOrderTokens() {
  const result = await query(
    `
      SELECT
        s.id,
        s."shopId" AS shop_id,
        s.region,
        s.status,
        s."accountId" AS account_id
      FROM "OAuthToken" t
      INNER JOIN "Shop" s ON s.id = t."shopId"
      WHERE t."accessToken" IS NOT NULL
         OR t."refreshToken" IS NOT NULL
      ORDER BY t."shopId" ASC
    `,
  );

  return result.rows.map(mapShopRow);
}

async function getAdsTokenRowByShopDbId(shopDbId) {
  return queryOne(
    `
      SELECT
        "adsAccessToken" AS ads_access_token,
        "adsAccessTokenExpiresAt" AS ads_access_token_expires_at,
        "adsRefreshToken" AS ads_refresh_token,
        "adsRefreshTokenExpiresAt" AS ads_refresh_token_expires_at
      FROM "OAuthToken"
      WHERE "shopId" = $1
      LIMIT 1
    `,
    [shopDbId],
  );
}

async function listConnectedAdsShopsSql() {
  const result = await query(
    `
      SELECT
        s.id,
        s."shopId" AS shop_id,
        s.region,
        s.status,
        s."accountId" AS account_id
      FROM "OAuthToken" t
      INNER JOIN "Shop" s ON s.id = t."shopId"
      WHERE t."adsAccessToken" IS NOT NULL
      ORDER BY s.id ASC
    `,
  );

  return result.rows.map(mapShopRow);
}

async function countAdsHourlyMetrics() {
  const row = await queryOne(
    `
      SELECT COUNT(*)::int AS total
      FROM "AdsHourlyMetric"
    `,
  );

  return Number(row?.total || 0);
}

async function findLatestAdsHourlyMetric() {
  return queryOne(
    `
      SELECT
        date,
        hour,
        expense,
        "shopId" AS shop_id,
        type,
        "itemId" AS item_id,
        "updatedAt" AS updated_at
      FROM "AdsHourlyMetric"
      ORDER BY date DESC, hour DESC, id DESC
      LIMIT 1
    `,
  );
}

async function listPendingAddressAlertsWithSnapshots() {
  const result = await query(
    `
      SELECT
        a.id,
        a.status,
        old_snap.zipcode AS old_zipcode,
        old_snap.state AS old_state,
        old_snap.city AS old_city,
        old_snap."fullAddress" AS old_full_address,
        new_snap.zipcode AS new_zipcode,
        new_snap.state AS new_state,
        new_snap.city AS new_city,
        new_snap."fullAddress" AS new_full_address
      FROM "OrderAddressChangeAlert" a
      LEFT JOIN "OrderAddressSnapshot" old_snap ON old_snap.id = a."oldSnapshotId"
      INNER JOIN "OrderAddressSnapshot" new_snap ON new_snap.id = a."newSnapshotId"
      WHERE a.status = 'PENDING'
      ORDER BY a.id ASC
    `,
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    status: row.status,
    oldSnapshot: row.old_state == null && row.old_city == null && row.old_zipcode == null && row.old_full_address == null
      ? null
      : {
          zipcode: row.old_zipcode || null,
          state: row.old_state || null,
          city: row.old_city || null,
          fullAddress: row.old_full_address || null,
        },
    newSnapshot: {
      zipcode: row.new_zipcode || null,
      state: row.new_state || null,
      city: row.new_city || null,
      fullAddress: row.new_full_address || null,
    },
  }));
}

async function resolveAddressAlert(alertId) {
  const row = await queryOne(
    `
      UPDATE "OrderAddressChangeAlert"
      SET status = 'RESOLVED', "updatedAt" = NOW()
      WHERE id = $1
      RETURNING id
    `,
    [alertId],
  );

  return Boolean(row);
}

module.exports = {
  countAdsHourlyMetrics,
  findLatestAdsHourlyMetric,
  findShopByDbIdAndAccountId,
  findShopByDbIdOrShopeeShopId,
  getAdsTokenRowByShopDbId,
  listConnectedAdsShopsSql,
  listPendingAddressAlertsWithSnapshots,
  listShopsWithOrderTokens,
  resolveAddressAlert,
};
