"use strict";

const crypto = require("crypto");

function amount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function component(type, value, sourcePath, metadata = {}) {
  return { type, amount: amount(value), sourceType: "API", sourcePath, metadata };
}

function compact(components) {
  return components.filter((item) => item.amount !== 0);
}

function normalizeMeli(result) {
  const summary = result.summary || {};
  const commission = amount(summary.saleFee) || amount(summary.marketplaceFee);
  const components = compact([
    component("commission", commission, summary.saleFee ? "order.order_items[].sale_fee" : "order.payments[].marketplace_fee"),
    component("shipping", summary.shippingSellerCost, "shipment.seller.cost"),
  ]);
  return { components, totalAmount: amount(components.reduce((sum, item) => sum + item.amount, 0)) };
}

function normalizeShopee(result) {
  const summary = result.summary || {};
  const netShipping = Math.max(0, amount(summary.actualShippingFee) - amount(summary.shopeeShippingRebate));
  const components = compact([
    component("commission", summary.commissionFee, "order_income.commission_fee"),
    component("service_fee", summary.serviceFee, "order_income.service_fee"),
    component("transaction_fee", summary.sellerTransactionFee, "order_income.seller_transaction_fee"),
    component("seller_discount", summary.sellerVoucher, "order_income.seller_voucher"),
    component("coins", summary.sellerCoinCashback, "order_income.seller_coin_cash_back"),
    component("shipping", netShipping, "order_income.actual_shipping_fee-shopee_shipping_rebate", { rebate: amount(summary.shopeeShippingRebate) }),
  ]);
  return { components, totalAmount: amount(components.reduce((sum, item) => sum + item.amount, 0)) };
}

function normalizeFeeResult(result) {
  const normalized = result?.channel === "shopee" ? normalizeShopee(result) : normalizeMeli(result || {});
  const canonical = JSON.stringify({
    channel: result?.channel,
    orderId: String(result?.orderId || ""),
    connectionId: result?.connectionId ? String(result.connectionId) : null,
    components: normalized.components,
  });
  return {
    ...normalized,
    currency: "BRL",
    fingerprint: crypto.createHash("sha256").update(canonical).digest("hex"),
  };
}

module.exports = { amount, normalizeFeeResult, normalizeMeli, normalizeShopee };
