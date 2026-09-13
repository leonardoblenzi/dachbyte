"use strict";

const {
  findShopByDbIdOrShopeeShopId,
} = require("../repositories/operationsSqlRepository");
const {
  insertPriceUpdateEvent,
  updateCachedProductPriceFromPush,
} = require("../repositories/priceIncreaseSqlRepository");
const { parseShopeePushPayload } = require("../webhooks/shopeePushParser");
const { buildPriceEventKey } = require("./priceIncreasePolicyService");
const {
  storeShopeePushNotice,
} = require("./ShopeePushNoticeService");

function getPayloadData(payload = {}) {
  return payload?.data && typeof payload.data === "object" ? payload.data : {};
}

function getShopeeShopIdFromPayload(payload = {}) {
  const data = getPayloadData(payload);
  return payload.shop_id || data.shop_id || payload.supplier_id || null;
}

async function processShopeePushPayload(payload = {}) {
  const parsed = parseShopeePushPayload(payload);
  const payloadShopId = getShopeeShopIdFromPayload(payload);
  const shop = payloadShopId
    ? await findShopByDbIdOrShopeeShopId(payloadShopId)
    : null;
  const noticeResult = await storeShopeePushNotice({ payload, shop });

  if (parsed.kind !== "item_price_update_push" || !parsed.priceUpdate) {
    const noticeStored = Boolean(noticeResult?.stored);
    return {
      ok: true,
      ignored: !noticeStored,
      reason: noticeStored ? "notice_stored" : noticeResult?.reason || "unsupported_push_code",
      code: parsed.code,
      notice: noticeResult,
    };
  }

  const push = parsed.priceUpdate;
  const priceShop = shop || (await findShopByDbIdOrShopeeShopId(push.shopId));
  if (!priceShop) {
    return {
      ok: true,
      ignored: true,
      reason: "shop_not_found",
      shopId: push.shopId,
      notice: noticeResult,
    };
  }

  const eventKey = buildPriceEventKey({
    shopId: push.shopId,
    code: push.code,
    timestamp: push.timestamp,
    itemId: push.itemId,
    modelId: push.modelId,
    updateField: push.updateField,
    oldValue: push.oldValue,
    newValue: push.newValue,
    updateTime: push.updateTime,
  });

  const eventId = await insertPriceUpdateEvent({
    eventKey,
    shopId: priceShop.id,
    itemId: push.itemId,
    modelId: push.modelId,
    updateField: push.updateField,
    oldValue: push.oldValue,
    newValue: push.newValue,
    updateTime: push.updateTime,
    pushTimestamp: push.pushTimestamp,
    isBlockedForPromotion: push.blocked,
    lockUntil: push.lockUntil,
    payload: push.payload,
  });

  const productPriceUpdate = await updateCachedProductPriceFromPush({
    shopId: priceShop.id,
    itemId: push.itemId,
    modelId: push.modelId,
    newValue: push.newValue,
  });

  return {
    ok: true,
    code: push.code,
    blockedForPromotion: push.blocked,
    eventKey,
    eventId,
    notice: noticeResult,
    productPriceUpdate,
  };
}

module.exports = {
  processShopeePushPayload,
};
