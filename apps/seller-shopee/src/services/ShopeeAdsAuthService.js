const axios = require("axios");
const qs = require("qs");
const shopeeAds = require("../config/shopeeAds");
const TokenRepository = require("../repositories/TokenRepository");
const { hmacSha256Hex } = require("../utils/crypto");

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function signAuthBase({ path, timestamp, partnerId }) {
  return `${partnerId}${path}${timestamp}`;
}

function sign({
  path,
  timestamp,
  partnerId,
  partnerKey,
}) {
  const base = signAuthBase({ path, timestamp, partnerId });
  return hmacSha256Hex(String(partnerKey || ""), base);
}

async function requestShopeeAdsAuth({
  method,
  path,
  query = {},
  body,
}) {
  const partnerId = shopeeAds.PARTNER_ID;
  const partnerKey = shopeeAds.PARTNER_KEY;

  if (!partnerId || !partnerKey) {
    const err = new Error(
      "Config Ads ausente: SHOPEE_ADS_PARTNER_ID / SHOPEE_ADS_PARTNER_KEY",
    );
    err.statusCode = 500;
    err.code = "ads_auth_config_missing";
    throw err;
  }

  const timestamp = nowTs();
  const signature = sign({
    path,
    timestamp,
    partnerId: String(partnerId),
    partnerKey,
  });

  const url = `${shopeeAds.SHOPEE_ADS_API_BASE}${path}`;
  const params = {
    ...query,
    partner_id: Number(partnerId),
    timestamp,
    sign: signature,
  };

  let data = body;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    data = { partner_id: Number(partnerId), ...data };
  }

  try {
    const response = await axios({
      method,
      url,
      params,
      paramsSerializer: (value) => qs.stringify(value, { arrayFormat: "repeat" }),
      data,
      timeout: 20_000,
    });
    return response.data;
  } catch (error) {
    const err = new Error("Shopee Ads auth error");
    err.statusCode = error.response?.status || 502;
    err.shopee = error.response?.data || { message: error.message };
    throw err;
  }
}

function normalizeShopeePayload(data) {
  if (!data) return null;
  if (data.data && typeof data.data === "object") return data.data;
  return data;
}

function throwShopeeErrorIfPresent(data) {
  const hasErrorMessage =
    typeof data?.message === "string" && data.message.trim().length > 0;
  const hasErrorField =
    typeof data?.error === "string" && data.error.trim().length > 0;

  if (hasErrorMessage || hasErrorField) {
    const err = new Error("Shopee Ads API error");
    err.statusCode = 502;
    err.shopee = data;
    throw err;
  }
}

async function exchangeCodeForToken({
  code,
  shopId,
  mainAccountId,
  persist = true,
}) {
  const sid = Number(shopId);
  if (!Number.isInteger(sid) || sid <= 0) {
    const err = new Error("shop_id invalido no callback de Ads");
    err.statusCode = 400;
    throw err;
  }

  const data = await requestShopeeAdsAuth({
    method: "post",
    path: "/api/v2/auth/token/get",
    body: {
      code,
      shop_id: sid,
      main_account_id: mainAccountId ? Number(mainAccountId) : undefined,
    },
  });

  throwShopeeErrorIfPresent(data);
  const payload = normalizeShopeePayload(data);

  if (
    !payload ||
    !payload.access_token ||
    !payload.refresh_token ||
    !payload.expire_in
  ) {
    const err = new Error("Resposta invalida da Shopee Ads (token/get)");
    err.statusCode = 502;
    err.shopee = data;
    throw err;
  }

  if (persist) {
    await TokenRepository.saveAdsTokens({
      shopId: sid,
      accessToken: payload.access_token,
      accessExpiresIn: payload.expire_in,
      refreshToken: payload.refresh_token,
      refreshExpiresIn: payload.refresh_expire_in,
    });
  }

  return payload;
}

async function refreshAccessToken({ shopId }) {
  const found = await TokenRepository.getTokensByShopId(shopId);
  if (!found?.tokens?.adsRefreshToken) {
    const err = new Error("Refresh token de Ads nao encontrado para esta loja");
    err.statusCode = 400;
    err.code = "ads_refresh_token_missing";
    throw err;
  }

  const data = await requestShopeeAdsAuth({
    method: "post",
    path: "/api/v2/auth/access_token/get",
    body: {
      shop_id: Number(shopId),
      refresh_token: found.tokens.adsRefreshToken,
    },
  });

  throwShopeeErrorIfPresent(data);
  const payload = normalizeShopeePayload(data);

  if (
    !payload ||
    !payload.access_token ||
    !payload.refresh_token ||
    !payload.expire_in
  ) {
    const err = new Error("Resposta invalida da Shopee Ads (access_token/get)");
    err.statusCode = 502;
    err.shopee = data;
    throw err;
  }

  await TokenRepository.saveAdsTokens({
    shopId,
    accessToken: payload.access_token,
    accessExpiresIn: payload.expire_in,
    refreshToken: payload.refresh_token,
    refreshExpiresIn: payload.refresh_expire_in,
  });

  return payload;
}

module.exports = {
  exchangeCodeForToken,
  refreshAccessToken,
};
