"use strict";

const {
  normalizePriceUpdatePush,
} = require("../services/priceIncreasePolicyService");

function parseShopeePushPayload(payload) {
  const body = payload && typeof payload === "object" ? payload : {};
  const priceUpdate = normalizePriceUpdatePush(body);

  return {
    kind: priceUpdate ? "item_price_update_push" : "unknown",
    code: Number(body.code) || null,
    priceUpdate,
    raw: body,
  };
}

module.exports = {
  parseShopeePushPayload,
};
