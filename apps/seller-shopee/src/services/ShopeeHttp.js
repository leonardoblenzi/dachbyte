const axios = require("axios");
const { hmacSha256Hex } = require("../utils/crypto");
const shopee = require("../config/shopee");
const qs = require("qs");

let shopeeTimeOffsetSeconds = 0;

function currentUnixTs() {
  return Math.floor(Date.now() / 1000);
}

function nowTs() {
  return currentUnixTs() + shopeeTimeOffsetSeconds;
}

function parseHeaderUnixTs(dateHeader) {
  const ms = Date.parse(String(dateHeader || ""));
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function syncOffsetFromHeader(dateHeader) {
  const serverTs = parseHeaderUnixTs(dateHeader);
  if (!Number.isFinite(serverTs)) return false;

  const nextOffset = serverTs - currentUnixTs();
  if (!Number.isFinite(nextOffset)) return false;

  if (nextOffset !== shopeeTimeOffsetSeconds) {
    shopeeTimeOffsetSeconds = nextOffset;
    console.log(
      `[ShopeeHttp] adjusted timestamp offset to ${shopeeTimeOffsetSeconds}s`,
    );
  }

  return true;
}

function isInvalidTimestampPayload(payload) {
  const message = String(payload?.message || payload?.error || "").toLowerCase();
  return message.includes("invalid timestamp");
}

function signAuthBase({ path, timestamp }) {
  const partnerId = String(shopee.PARTNER_ID || "");
  return `${partnerId}${path}${timestamp}`;
}

function signApiBase({ path, timestamp, accessToken, shopId }) {
  const partnerId = String(shopee.PARTNER_ID || "");
  const token = accessToken ? String(accessToken) : "";
  const sid = shopId !== undefined && shopId !== null ? String(shopId) : "";
  return `${partnerId}${path}${timestamp}${token}${sid}`;
}

function sign({ path, timestamp, accessToken, shopId, signType = "api" }) {
  const base =
    signType === "auth"
      ? signAuthBase({ path, timestamp })
      : signApiBase({ path, timestamp, accessToken, shopId });

  return hmacSha256Hex(String(shopee.PARTNER_KEY || ""), base);
}

async function requestShopee({
  method,
  path,
  query = {},
  body,
  accessToken,
  shopId,
  signType = "api",
  retryAttempt = 0,
}) {
  const partnerId = shopee.PARTNER_ID;
  const partnerKey = shopee.PARTNER_KEY;

  if (!partnerId || !partnerKey) {
    const e = new Error("Config Shopee ausente: PARTNER_ID/PARTNER_KEY");
    e.statusCode = 500;
    throw e;
  }

  const timestamp = nowTs();
  const signature = sign({ path, timestamp, accessToken, shopId, signType });

  const url = `${shopee.SHOPEE_API_BASE}${path}`;

  const params = {
    ...query,
    partner_id: Number(partnerId),
    timestamp,
    sign: signature,
  };

  if (accessToken) params.access_token = accessToken;
  if (shopId !== undefined && shopId !== null) params.shop_id = String(shopId);

  let data = body;

  // ✅ garante compatibilidade com endpoints de AUTH que exigem partner_id no body
  if (
    signType === "auth" &&
    data &&
    typeof data === "object" &&
    !Array.isArray(data)
  ) {
    data = { partner_id: Number(partnerId), ...data };
  }

  console.log("[ShopeeHttp] URL:", url);

  try {
    const res = await axios({
      method,
      url,
      params,
      paramsSerializer: (p) => qs.stringify(p, { arrayFormat: "repeat" }),
      data,
      timeout: 20000,
    });
    syncOffsetFromHeader(res?.headers?.date);

    if (
      retryAttempt < 1 &&
      isInvalidTimestampPayload(res?.data) &&
      syncOffsetFromHeader(res?.headers?.date)
    ) {
      return requestShopee({
        method,
        path,
        query,
        body,
        accessToken,
        shopId,
        signType,
        retryAttempt: retryAttempt + 1,
      });
    }

    return res.data;
  } catch (err) {
    const status = err.response ? err.response.status : 502;
    const payload = err.response ? err.response.data : { message: err.message };
    const didSyncOffset = syncOffsetFromHeader(err?.response?.headers?.date);

    if (retryAttempt < 1 && isInvalidTimestampPayload(payload) && didSyncOffset) {
      return requestShopee({
        method,
        path,
        query,
        body,
        accessToken,
        shopId,
        signType,
        retryAttempt: retryAttempt + 1,
      });
    }

    const e = new Error("Shopee API error");
    e.statusCode = status;
    e.shopee = payload;
    throw e;
  }
}

module.exports = {
  requestShopee,
};
