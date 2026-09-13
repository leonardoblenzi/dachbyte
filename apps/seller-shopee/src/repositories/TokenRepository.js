const {
  findShopAndTokensByShopeeShopId,
  upsertOAuthTokens,
  upsertShop,
  toBigIntShopId,
} = require("./oauthSqlRepository");

async function ensureAuthorizedShop(shopId, region = null) {
  const shopeeShopId = toBigIntShopId(shopId);
  return upsertShop({
    shopId: shopeeShopId,
    region,
    status: "AUTHORIZED",
  });
}

async function saveTokens({
  shopId,
  accessToken,
  accessExpiresIn,
  refreshToken,
  refreshExpiresIn,
}) {
  const shop = await ensureAuthorizedShop(shopId, null);

  const accessTokenExpiresAt = accessExpiresIn
    ? new Date(Date.now() + Number(accessExpiresIn) * 1000)
    : null;

  const refreshTokenExpiresAt = refreshExpiresIn
    ? new Date(Date.now() + Number(refreshExpiresIn) * 1000)
    : null;

  return upsertOAuthTokens({
    shopDbId: shop.id,
    authFlow: "shop",
    accessToken: accessToken || null,
    accessTokenExpiresAt,
    refreshToken: refreshToken || null,
    refreshTokenExpiresAt,
  });
}

async function saveAdsTokens({
  shopId,
  accessToken,
  accessExpiresIn,
  refreshToken,
  refreshExpiresIn,
}) {
  const shop = await ensureAuthorizedShop(shopId, null);

  const adsAccessTokenExpiresAt = accessExpiresIn
    ? new Date(Date.now() + Number(accessExpiresIn) * 1000)
    : null;

  const adsRefreshTokenExpiresAt = refreshExpiresIn
    ? new Date(Date.now() + Number(refreshExpiresIn) * 1000)
    : null;

  return upsertOAuthTokens({
    shopDbId: shop.id,
    authFlow: "ads",
    accessToken: accessToken || null,
    accessTokenExpiresAt: adsAccessTokenExpiresAt,
    refreshToken: refreshToken || null,
    refreshTokenExpiresAt: adsRefreshTokenExpiresAt,
  });
}

async function getTokensByShopId(shopId) {
  const shopeeShopId = toBigIntShopId(shopId);
  const found = await findShopAndTokensByShopeeShopId(shopeeShopId);
  if (!found || !found.tokens) return null;
  return found;
}

module.exports = {
  saveTokens,
  saveAdsTokens,
  getTokensByShopId,
};
