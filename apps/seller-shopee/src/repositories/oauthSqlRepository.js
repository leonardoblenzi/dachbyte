"use strict";

const { queryOne } = require("../config/postgres");

function toBigIntShopId(shopId) {
  if (shopId === undefined || shopId === null) {
    const err = new Error("shopId ausente");
    err.statusCode = 400;
    throw err;
  }

  const value = String(shopId).trim();
  if (!value) {
    const err = new Error("shopId vazio");
    err.statusCode = 400;
    throw err;
  }

  try {
    return BigInt(value);
  } catch (_error) {
    const err = new Error(
      "shopId invalido (nao foi possivel converter para BigInt)",
    );
    err.statusCode = 400;
    throw err;
  }
}

function mapShopRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    accountId: row.account_id == null ? null : Number(row.account_id),
    shopId: row.shop_id == null ? null : BigInt(row.shop_id),
    region: row.region || null,
    status: row.status || null,
  };
}

function mapTokensRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    shopId: Number(row.shop_id),
    accessToken: row.access_token || null,
    accessTokenExpiresAt: row.access_token_expires_at || null,
    refreshToken: row.refresh_token || null,
    refreshTokenExpiresAt: row.refresh_token_expires_at || null,
    adsAccessToken: row.ads_access_token || null,
    adsAccessTokenExpiresAt: row.ads_access_token_expires_at || null,
    adsRefreshToken: row.ads_refresh_token || null,
    adsRefreshTokenExpiresAt: row.ads_refresh_token_expires_at || null,
  };
}

async function findShopByShopeeShopId(shopId) {
  const shopeeShopId = toBigIntShopId(shopId);
  const row = await queryOne(
    `
      SELECT
        id,
        "accountId" AS account_id,
        "shopId" AS shop_id,
        region,
        status
      FROM "Shop"
      WHERE "shopId" = $1
      LIMIT 1
    `,
    [shopeeShopId.toString()],
  );

  return mapShopRow(row);
}

async function upsertShop({
  shopId,
  accountId = null,
  region = null,
  status = "AUTHORIZED",
}) {
  const shopeeShopId = toBigIntShopId(shopId);
  const row = await queryOne(
    `
      INSERT INTO "Shop" (
        "accountId",
        "shopId",
        region,
        status,
        "createdAt",
        "updatedAt"
      )
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      ON CONFLICT ("shopId")
      DO UPDATE SET
        "accountId" = COALESCE("Shop"."accountId", EXCLUDED."accountId"),
        region = COALESCE(EXCLUDED.region, "Shop".region),
        status = EXCLUDED.status,
        "updatedAt" = NOW()
      RETURNING
        id,
        "accountId" AS account_id,
        "shopId" AS shop_id,
        region,
        status
    `,
    [
      accountId,
      shopeeShopId.toString(),
      region,
      status,
    ],
  );

  return mapShopRow(row);
}

async function upsertOAuthTokens({
  shopDbId,
  authFlow = "shop",
  accessToken = null,
  accessTokenExpiresAt = null,
  refreshToken = null,
  refreshTokenExpiresAt = null,
}) {
  const isAds = authFlow === "ads";
  const row = await queryOne(
    `
      INSERT INTO "OAuthToken" (
        "shopId",
        "accessToken",
        "accessTokenExpiresAt",
        "refreshToken",
        "refreshTokenExpiresAt",
        "adsAccessToken",
        "adsAccessTokenExpiresAt",
        "adsRefreshToken",
        "adsRefreshTokenExpiresAt",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        NOW(),
        NOW()
      )
      ON CONFLICT ("shopId")
      DO UPDATE SET
        "accessToken" = COALESCE(EXCLUDED."accessToken", "OAuthToken"."accessToken"),
        "accessTokenExpiresAt" = COALESCE(EXCLUDED."accessTokenExpiresAt", "OAuthToken"."accessTokenExpiresAt"),
        "refreshToken" = COALESCE(EXCLUDED."refreshToken", "OAuthToken"."refreshToken"),
        "refreshTokenExpiresAt" = COALESCE(EXCLUDED."refreshTokenExpiresAt", "OAuthToken"."refreshTokenExpiresAt"),
        "adsAccessToken" = COALESCE(EXCLUDED."adsAccessToken", "OAuthToken"."adsAccessToken"),
        "adsAccessTokenExpiresAt" = COALESCE(EXCLUDED."adsAccessTokenExpiresAt", "OAuthToken"."adsAccessTokenExpiresAt"),
        "adsRefreshToken" = COALESCE(EXCLUDED."adsRefreshToken", "OAuthToken"."adsRefreshToken"),
        "adsRefreshTokenExpiresAt" = COALESCE(EXCLUDED."adsRefreshTokenExpiresAt", "OAuthToken"."adsRefreshTokenExpiresAt"),
        "updatedAt" = NOW()
      RETURNING
        id,
        "shopId" AS shop_id,
        "accessToken" AS access_token,
        "accessTokenExpiresAt" AS access_token_expires_at,
        "refreshToken" AS refresh_token,
        "refreshTokenExpiresAt" AS refresh_token_expires_at,
        "adsAccessToken" AS ads_access_token,
        "adsAccessTokenExpiresAt" AS ads_access_token_expires_at,
        "adsRefreshToken" AS ads_refresh_token,
        "adsRefreshTokenExpiresAt" AS ads_refresh_token_expires_at
    `,
    [
      shopDbId,
      isAds ? null : accessToken,
      isAds ? null : accessTokenExpiresAt,
      isAds ? null : refreshToken,
      isAds ? null : refreshTokenExpiresAt,
      isAds ? accessToken : null,
      isAds ? accessTokenExpiresAt : null,
      isAds ? refreshToken : null,
      isAds ? refreshTokenExpiresAt : null,
    ],
  );

  return mapTokensRow(row);
}

async function findShopAndTokensByShopeeShopId(shopId) {
  const shopeeShopId = toBigIntShopId(shopId);
  const row = await queryOne(
    `
      SELECT
        s.id AS shop_db_id,
        s."accountId" AS shop_account_id,
        s."shopId" AS shop_shop_id,
        s.region AS shop_region,
        s.status AS shop_status,
        t.id,
        t."shopId" AS token_shop_id,
        t."accessToken" AS access_token,
        t."accessTokenExpiresAt" AS access_token_expires_at,
        t."refreshToken" AS refresh_token,
        t."refreshTokenExpiresAt" AS refresh_token_expires_at,
        t."adsAccessToken" AS ads_access_token,
        t."adsAccessTokenExpiresAt" AS ads_access_token_expires_at,
        t."adsRefreshToken" AS ads_refresh_token,
        t."adsRefreshTokenExpiresAt" AS ads_refresh_token_expires_at
      FROM "Shop" s
      LEFT JOIN "OAuthToken" t ON t."shopId" = s.id
      WHERE s."shopId" = $1
      LIMIT 1
    `,
    [shopeeShopId.toString()],
  );

  if (!row) {
    return null;
  }

  return {
    shop: mapShopRow({
      id: row.shop_db_id,
      account_id: row.shop_account_id,
      shop_id: row.shop_shop_id,
      region: row.shop_region,
      status: row.shop_status,
    }),
    tokens: row.id
      ? mapTokensRow({
          id: row.id,
          shop_id: row.token_shop_id,
          access_token: row.access_token,
          access_token_expires_at: row.access_token_expires_at,
          refresh_token: row.refresh_token,
          refresh_token_expires_at: row.refresh_token_expires_at,
          ads_access_token: row.ads_access_token,
          ads_access_token_expires_at: row.ads_access_token_expires_at,
          ads_refresh_token: row.ads_refresh_token,
          ads_refresh_token_expires_at: row.ads_refresh_token_expires_at,
        })
      : null,
  };
}

module.exports = {
  findShopAndTokensByShopeeShopId,
  findShopByShopeeShopId,
  toBigIntShopId,
  upsertOAuthTokens,
  upsertShop,
};
