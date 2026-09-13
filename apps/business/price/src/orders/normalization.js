"use strict";

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function text(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function marketplaceName(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("mercado") || normalized.includes("meli") || normalized === "ml") return "meli";
  if (normalized.includes("shopee")) return "shopee";
  return null;
}

function marketplaceAccountId(order, marketplaceOrder, mlOrder) {
  return text(
    marketplaceOrder?.seller_id || marketplaceOrder?.sellerId || marketplaceOrder?.user_id ||
    mlOrder?.seller_id || mlOrder?.sellerId || mlOrder?.user_id ||
    order.marketplace_seller_id || order.marketplace_user_id,
  );
}

function normalizeTrayOrder(wrapper) {
  const order = wrapper?.Order || wrapper || {};
  const marketplaceOrder = first(order.MarketplaceOrder);
  const mlOrder = first(order.MlOrder);
  const explicitMarketplace = marketplaceName(
    marketplaceOrder?.marketplace || marketplaceOrder?.name || order.marketplace || order.point_sale,
  );
  const explicitId = text(
    marketplaceOrder?.platform_order_id || marketplaceOrder?.order_id || marketplaceOrder?.id ||
    mlOrder?.order_id || mlOrder?.id,
  );
  const fallbackId = text(order.external_code);
  const marketplace = mlOrder ? "meli" : explicitMarketplace;
  const marketplaceOrderId = explicitId || (marketplace ? fallbackId : null);
  const accountId = marketplaceAccountId(order, marketplaceOrder, mlOrder);
  const matched = Boolean(marketplace && marketplaceOrderId);
  const hasWeakReference = Boolean(!matched && (order.point_sale || order.external_code));

  return {
    sourceOrderId: text(order.id),
    status: text(order.status),
    orderDate: text(order.date),
    modifiedAt: text(order.modified),
    totalAmount: numberOrNull(order.total),
    marketplace,
    marketplaceOrderId,
    marketplaceAccountId: accountId,
    marketplaceAccountSource: accountId ? "tray_explicit" : null,
    reconciliationStatus: matched ? "matched" : (hasWeakReference ? "review" : "unmatched"),
    matchConfidence: matched ? 1 : null,
    matchReason: matched ? "tray_explicit_marketplace_id" : (hasWeakReference ? "weak_reference_requires_review" : null),
    normalizedData: {
      source: "tray",
      sourceOrderId: text(order.id),
      status: text(order.status),
      orderDate: text(order.date),
      modifiedAt: text(order.modified),
      totalAmount: numberOrNull(order.total),
      pointOfSale: text(order.point_sale),
    },
    raw: order,
  };
}

function syncWindow({ from, to, checkpoint, now = new Date() }) {
  const end = text(to) || now.toISOString().slice(0, 10);
  if (text(from)) return { from: text(from), to: end, mode: "manual" };
  const checkpointDate = text(checkpoint?.cursor?.maxModifiedAt || checkpoint?.cursor?.windowTo);
  if (checkpointDate) {
    const date = new Date(checkpointDate);
    date.setUTCDate(date.getUTCDate() - 1);
    return { from: date.toISOString().slice(0, 10), to: end, mode: "incremental" };
  }
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - 90);
  return { from: start.toISOString().slice(0, 10), to: end, mode: "historical" };
}

module.exports = { normalizeTrayOrder, syncWindow, marketplaceName, marketplaceAccountId };
