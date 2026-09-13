const ShopeeAdsAuthService = require("./ShopeeAdsAuthService");
const {
  getAdsTokenRowByShopDbId,
  listConnectedAdsShopsSql,
} = require("../repositories/operationsSqlRepository");

function getShopeeErrData(error) {
  return error?.response?.data || error?.shopee || null;
}

function isInvalidAccessToken(error) {
  const data = getShopeeErrData(error);
  const err = String(data?.error || "").toLowerCase();
  return err === "invalid_acceess_token" || err === "invalid_access_token";
}

function buildAdsNotConnectedError() {
  const err = new Error(
    "Ads nao conectado para esta loja. Clique em Integrar Ads para autorizar o app de Ads.",
  );
  err.statusCode = 400;
  err.code = "ads_not_connected";
  return err;
}

async function getDbAdsTokenRow(dbShopId) {
  const row = await getAdsTokenRowByShopDbId(Number(dbShopId));
  if (!row) return null;
  return {
    adsAccessToken: row.ads_access_token || null,
    adsAccessTokenExpiresAt: row.ads_access_token_expires_at || null,
    adsRefreshToken: row.ads_refresh_token || null,
    adsRefreshTokenExpiresAt: row.ads_refresh_token_expires_at || null,
  };
}

async function getShopAdsAccessToken(dbShopId) {
  const tokenRow = await getDbAdsTokenRow(dbShopId);
  return tokenRow?.adsAccessToken || null;
}

async function refreshAndReloadAdsAccessToken({ dbShopId, shopeeShopId }) {
  await ShopeeAdsAuthService.refreshAccessToken({ shopId: String(shopeeShopId) });
  const refreshed = await getDbAdsTokenRow(dbShopId);
  return refreshed?.adsAccessToken || null;
}

async function callAdsWithAutoRefresh({ shop, call }) {
  const tokenRow = await getDbAdsTokenRow(shop.id);
  const token = tokenRow?.adsAccessToken || null;

  if (!token) {
    throw buildAdsNotConnectedError();
  }

  try {
    return await call(token);
  } catch (error) {
    if (!isInvalidAccessToken(error)) throw error;

    const newToken = await refreshAndReloadAdsAccessToken({
      dbShopId: shop.id,
      shopeeShopId: shop.shopId,
    });

    if (!newToken) throw error;
    return await call(newToken);
  }
}

async function listConnectedAdsShops() {
  return listConnectedAdsShopsSql();
}

module.exports = {
  buildAdsNotConnectedError,
  callAdsWithAutoRefresh,
  getDbAdsTokenRow,
  getShopAdsAccessToken,
  getShopeeErrData,
  isInvalidAccessToken,
  listConnectedAdsShops,
  refreshAndReloadAdsAccessToken,
};
