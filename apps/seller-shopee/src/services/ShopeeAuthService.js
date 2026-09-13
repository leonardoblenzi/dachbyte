const { requestShopee } = require("./ShopeeHttp");
const TokenRepository = require("../repositories/TokenRepository");

function normalizeShopeePayload(data) {
  if (!data) return null;

  // Formato comum: { data: { ... } }
  if (data.data && typeof data.data === "object") return data.data;

  // Formato que você recebeu: { access_token, refresh_token, expire_in, ... }
  return data;
}

function throwShopeeErrorIfPresent(data) {
  // Só trate como erro quando houver sinal real de erro no body
  const hasErrorMessage =
    typeof data?.message === "string" && data.message.trim().length > 0;
  const hasErrorField =
    typeof data?.error === "string" && data.error.trim().length > 0;

  if (hasErrorMessage || hasErrorField) {
    const err = new Error("Shopee API error");
    err.statusCode = 502;
    err.shopee = data;
    throw err;
  }
}

async function exchangeCodeForToken({ code, shopId, mainAccountId }) {
  const sid = Number(shopId);
  if (!Number.isInteger(sid) || sid <= 0) {
    const err = new Error("shop_id inválido no callback");
    err.statusCode = 400;
    throw err;
  }

  const data = await requestShopee({
    method: "post",
    path: "/api/v2/auth/token/get",
    body: {
      code,
      shop_id: sid,
      main_account_id: mainAccountId ? Number(mainAccountId) : undefined,
    },
    signType: "auth",
  });

  throwShopeeErrorIfPresent(data);

  const payload = normalizeShopeePayload(data);

  if (
    !payload ||
    !payload.access_token ||
    !payload.refresh_token ||
    !payload.expire_in
  ) {
    const err = new Error("Resposta inválida da Shopee (token/get)");
    err.statusCode = 502;
    err.shopee = data;
    throw err;
  }

  await TokenRepository.saveTokens({
    shopId: sid,
    accessToken: payload.access_token,
    accessExpiresIn: payload.expire_in,
    refreshToken: payload.refresh_token,
    refreshExpiresIn: payload.refresh_expire_in,
  });

  return payload;
}

async function refreshAccessToken({ shopId }) {
  const found = await TokenRepository.getTokensByShopId(shopId);
  if (!found || !found.tokens || !found.tokens.refreshToken) {
    const err = new Error("Refresh token não encontrado para este shop_id");
    err.statusCode = 400;
    throw err;
  }

  const data = await requestShopee({
    method: "post",
    path: "/api/v2/auth/access_token/get",
    body: {
      shop_id: Number(shopId),
      refresh_token: found.tokens.refreshToken,
    },
    signType: "auth",
  });

  throwShopeeErrorIfPresent(data);

  const payload = normalizeShopeePayload(data);

  if (
    !payload ||
    !payload.access_token ||
    !payload.refresh_token ||
    !payload.expire_in
  ) {
    const err = new Error("Resposta inválida da Shopee (access_token/get)");
    err.statusCode = 502;
    err.shopee = data;
    throw err;
  }

  await TokenRepository.saveTokens({
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
