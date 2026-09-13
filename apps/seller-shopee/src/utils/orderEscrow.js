"use strict";

function getEscrowPayload(order) {
  const raw = order?.incomeDetailRaw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw;
}

function getIncomeInfo(order) {
  const payload = getEscrowPayload(order);
  if (!payload) return {};

  const nested = payload.order_income;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested;
  }

  return payload;
}

function getBuyerPaymentInfo(order) {
  const payload = getEscrowPayload(order);
  const info = getIncomeInfo(order);
  const raw = payload?.buyer_payment_info ?? info?.buyer_payment_info;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw;
}

function getOrderAdjustments(order) {
  const info = getIncomeInfo(order);
  return Array.isArray(info?.order_adjustment) ? info.order_adjustment : [];
}

function getReturnOrderSnList(order) {
  const payload = getEscrowPayload(order);
  const info = getIncomeInfo(order);
  const list = Array.isArray(payload?.return_order_sn_list)
    ? payload.return_order_sn_list
    : Array.isArray(info?.return_order_sn_list)
      ? info.return_order_sn_list
      : [];

  return list.filter(Boolean).map((item) => String(item));
}

function getBuyerUserName(order) {
  const payload = getEscrowPayload(order);
  const info = getIncomeInfo(order);
  const value = payload?.buyer_user_name ?? info?.buyer_user_name;
  return value ? String(value) : null;
}

function hasRichEscrowPayload(order) {
  const payload = getEscrowPayload(order);
  return Boolean(
    payload &&
      (payload.order_income ||
        payload.buyer_payment_info ||
        Array.isArray(payload.return_order_sn_list)),
  );
}

module.exports = {
  getEscrowPayload,
  getIncomeInfo,
  getBuyerPaymentInfo,
  getOrderAdjustments,
  getReturnOrderSnList,
  getBuyerUserName,
  hasRichEscrowPayload,
};
