const { requestShopee } = require("./ShopeeHttp");
const TokenRepository = require("../repositories/TokenRepository");
const ShopeeAuthService = require("./ShopeeAuthService");

function isExpiringSoon(date, skewSeconds = 180) {
  if (!date) return true;
  return Date.now() >= new Date(date).getTime() - skewSeconds * 1000;
}

function tokenErrorHeuristic(payload) {
  const msg = String(payload?.message || payload?.error || "").toLowerCase();
  return (
    msg.includes("token") || msg.includes("expired") || msg.includes("invalid")
  );
}

async function getValidAccessToken(shopId) {
  const found = await TokenRepository.getTokensByShopId(shopId);
  if (!found || !found.tokens) {
    const err = new Error("Tokens não encontrados para este shop_id");
    err.statusCode = 400;
    throw err;
  }

  const { accessToken, accessTokenExpiresAt } = found.tokens;

  if (!accessToken || isExpiringSoon(accessTokenExpiresAt)) {
    const refreshed = await ShopeeAuthService.refreshAccessToken({
      shopId: String(shopId),
    });
    return refreshed.access_token;
  }

  return accessToken;
}

async function requestShopeeAuthed({ method, path, query, body, shopId }) {
  const accessToken = await getValidAccessToken(shopId);

  try {
    return await requestShopee({
      method,
      path,
      query,
      body,
      accessToken,
      shopId: String(shopId),
      signType: "api",
    });
  } catch (err) {
    if (err?.shopee && tokenErrorHeuristic(err.shopee)) {
      const refreshed = await ShopeeAuthService.refreshAccessToken({
        shopId: String(shopId),
      });
      return await requestShopee({
        method,
        path,
        query,
        body,
        accessToken: refreshed.access_token,
        shopId: String(shopId),
        signType: "api",
      });
    }
    throw err;
  }
}

module.exports = { requestShopeeAuthed };
