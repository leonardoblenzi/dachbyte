"use strict";

const crypto = require("crypto");

const PROMOTION_BLOCK_DAYS = 7;

function toFiniteNumberOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBigIntStringOrNull(value) {
  if (value == null || value === "") return null;
  try {
    return BigInt(String(value)).toString();
  } catch (_error) {
    return null;
  }
}

function toDateOrNull(value) {
  if (value == null || value === "") return null;
  const asNumber = Number(value);
  const date = Number.isFinite(asNumber)
    ? new Date(asNumber * 1000)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isPriceIncrease(oldValue, newValue) {
  const oldNum = toFiniteNumberOrNull(oldValue);
  const newNum = toFiniteNumberOrNull(newValue);
  if (oldNum == null || newNum == null) return false;
  return newNum > oldNum;
}

function computePromotionLockUntil(updateTime) {
  if (!(updateTime instanceof Date) || Number.isNaN(updateTime.getTime())) {
    return null;
  }
  return new Date(
    updateTime.getTime() + PROMOTION_BLOCK_DAYS * 24 * 60 * 60 * 1000,
  );
}

function buildPriceEventKey({
  shopId,
  code,
  timestamp,
  itemId,
  modelId,
  updateField,
  oldValue,
  newValue,
  updateTime,
}) {
  const raw = [
    String(shopId || ""),
    String(code || ""),
    String(timestamp || ""),
    String(toBigIntStringOrNull(itemId) || ""),
    String(toBigIntStringOrNull(modelId) || ""),
    String(updateField || ""),
    String(toFiniteNumberOrNull(oldValue) ?? ""),
    String(toFiniteNumberOrNull(newValue) ?? ""),
    String(
      updateTime instanceof Date && !Number.isNaN(updateTime.getTime())
        ? Math.floor(updateTime.getTime() / 1000)
        : "",
    ),
  ].join("|");
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function normalizePriceUpdatePush(payload) {
  const body = payload && typeof payload === "object" ? payload : {};
  const wrappedPayload =
    body.payload && typeof body.payload === "object" ? body.payload : null;
  const candidate = wrappedPayload || body;
  const data =
    candidate.data && typeof candidate.data === "object"
      ? candidate.data
      : body.data && typeof body.data === "object"
        ? body.data
        : {};
  const rawCategory = String(
    body.category ||
      body.push_category ||
      body.pushCategory ||
      body.event ||
      body.event_name ||
      body.eventName ||
      "",
  )
    .trim()
    .toLowerCase();
  const code = Number(candidate.code ?? body.code);
  if (code !== 22 && rawCategory !== "item_price_update") return null;

  const shopId = toBigIntStringOrNull(
    candidate.shop_id ?? candidate.shopId ?? body.shop_id ?? body.shopId,
  );
  const itemId = toBigIntStringOrNull(data.item_id ?? data.itemId);
  const modelId = toBigIntStringOrNull(data.model_id ?? data.modelId);
  const updateFieldRaw = String(
    data.update_field ?? data.updateField ?? "",
  ).trim();
  const updateField = updateFieldRaw.toLowerCase();
  const oldValue = toFiniteNumberOrNull(data.old_value ?? data.oldValue);
  const newValue = toFiniteNumberOrNull(data.new_value ?? data.newValue);
  const updateTime = toDateOrNull(data.update_time ?? data.updateTime);
  const pushTimestamp = toDateOrNull(candidate.timestamp ?? body.timestamp);

  if (!shopId || !itemId || !updateField || !updateTime) return null;
  if (updateField !== "original_price" && updateField !== "local_price") {
    return null;
  }

  const blocked = isPriceIncrease(oldValue, newValue);
  return {
    shopId,
    itemId,
    modelId,
    updateField,
    oldValue,
    newValue,
    updateTime,
    pushTimestamp,
    code: code === 22 ? code : 22,
    timestamp: Number(candidate.timestamp ?? body.timestamp) || null,
    blocked,
    lockUntil: blocked ? computePromotionLockUntil(updateTime) : null,
    payload: body,
  };
}

function formatRemainingFromLock(lockUntil, now = new Date()) {
  if (!(lockUntil instanceof Date) || Number.isNaN(lockUntil.getTime())) {
    return {
      isBlocked: false,
      remainingMs: 0,
      remainingLabel: "Liberado",
    };
  }
  const diff = lockUntil.getTime() - now.getTime();
  if (diff <= 0) {
    return {
      isBlocked: false,
      remainingMs: 0,
      remainingLabel: "Liberado",
    };
  }

  const totalMinutes = Math.ceil(diff / (60 * 1000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  let remainingLabel = "";
  if (days > 0) {
    remainingLabel = `${days}d ${hours}h`;
  } else if (hours > 0) {
    remainingLabel = `${hours}h ${minutes}min`;
  } else {
    remainingLabel = `${minutes}min`;
  }

  return {
    isBlocked: true,
    remainingMs: diff,
    remainingLabel,
  };
}

module.exports = {
  PROMOTION_BLOCK_DAYS,
  normalizePriceUpdatePush,
  buildPriceEventKey,
  formatRemainingFromLock,
};
