"use strict";

const { requestShopee } = require("./ShopeeHttp");

function normalizeIntList(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item) && item >= 0)
        .map((item) => Math.trunc(item)),
    ),
  );
}

function normalizeSetConfigPayload(body = {}) {
  const payload = {};

  if (body.callback_url != null) {
    payload.callback_url = String(body.callback_url || "").trim();
  }

  const onList = normalizeIntList(body.set_push_config_on);
  const offList = normalizeIntList(body.set_push_config_off);
  const blockedList = normalizeIntList(body.blocked_shop_id_list).slice(0, 500);

  if (onList.length) payload.set_push_config_on = onList;
  if (offList.length) payload.set_push_config_off = offList;
  if (blockedList.length) payload.blocked_shop_id_list = blockedList;

  return payload;
}

function normalizeLastMessageId(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

async function callPartnerPushApi({ method, path, body = null }) {
  return requestShopee({
    method,
    path,
    body,
    signType: "auth",
  });
}

async function getAppPushConfig() {
  return callPartnerPushApi({
    method: "GET",
    path: "/api/v2/push/get_app_push_config",
  });
}

async function setAppPushConfig(body = {}) {
  const payload = normalizeSetConfigPayload(body);
  return callPartnerPushApi({
    method: "POST",
    path: "/api/v2/push/set_app_push_config",
    body: payload,
  });
}

async function getPushConfig() {
  return callPartnerPushApi({
    method: "GET",
    path: "/api/v2/push/get_push_config",
  });
}

async function setPushConfig(body = {}) {
  const payload = normalizeSetConfigPayload(body);
  return callPartnerPushApi({
    method: "POST",
    path: "/api/v2/push/set_push_config",
    body: payload,
  });
}

function parseLostPushData(dataValue) {
  if (typeof dataValue !== "string") return dataValue;
  try {
    return JSON.parse(dataValue);
  } catch (_error) {
    return dataValue;
  }
}

async function getLostPushMessage() {
  const response = await callPartnerPushApi({
    method: "GET",
    path: "/api/v2/push/get_lost_push_message",
  });

  const list = Array.isArray(response?.response?.push_message_list)
    ? response.response.push_message_list
    : [];

  return {
    ...response,
    response: {
      ...(response?.response || {}),
      push_message_list: list.map((item) => ({
        ...item,
        parsed_data: parseLostPushData(item?.data),
      })),
    },
  };
}

async function confirmConsumedLostPushMessage(lastMessageId) {
  const normalizedLastMessageId = normalizeLastMessageId(lastMessageId);
  if (!normalizedLastMessageId) {
    const error = new Error("last_message_id invalido.");
    error.statusCode = 400;
    throw error;
  }

  return callPartnerPushApi({
    method: "POST",
    path: "/api/v2/push/confirm_consumed_lost_push_message",
    body: {
      last_message_id: normalizedLastMessageId,
    },
  });
}

module.exports = {
  getAppPushConfig,
  setAppPushConfig,
  getPushConfig,
  setPushConfig,
  getLostPushMessage,
  confirmConsumedLostPushMessage,
};
