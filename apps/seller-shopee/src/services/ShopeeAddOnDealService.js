const { requestShopeeAuthed } = require("./ShopeeAuthedHttp");

function hasShopeeError(payload) {
  const raw = payload?.error;
  if (raw == null || raw === 0 || raw === "0") return false;
  return !(typeof raw === "string" && raw.trim() === "");
}

function ensureShopeeSuccess(payload, operation) {
  if (!hasShopeeError(payload)) return payload;

  const code = String(payload?.error || "shopee_error");
  const message = String(payload?.message || payload?.warning || "").trim();
  const error = new Error(`${operation} falhou${message ? `: ${message}` : ""} (${code})`);
  error.shopee = payload;
  throw error;
}

function normalizePositiveInteger(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} inválido`);
  }
  return parsed;
}

function toUnixSeconds(value, fieldName) {
  const date = value instanceof Date ? value : new Date(value);
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${fieldName} inválido`);
  }
  return Math.floor(milliseconds / 1000);
}

function buildGiftDealPayload({ name, startAt, endAt, minSpendCents } = {}) {
  const addOnDealName = String(name || "").trim();
  if (!addOnDealName) throw new Error("nome da campanha é obrigatório");

  const cents = Number(minSpendCents);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error("valor mínimo da campanha inválido");
  }

  const startTime = toUnixSeconds(startAt, "início da campanha");
  const endTime = toUnixSeconds(endAt, "fim da campanha");
  if (endTime <= startTime) {
    throw new Error("fim da campanha deve ser posterior ao início");
  }

  return {
    add_on_deal_name: addOnDealName,
    start_time: startTime,
    end_time: endTime,
    promotion_type: 1,
    purchase_min_spend: cents / 100,
    per_gift_num: 1,
  };
}

function extractAddOnDealId(payload) {
  const candidate = payload?.response?.add_on_deal_id
    ?? payload?.response?.addOnDealId
    ?? payload?.add_on_deal_id
    ?? payload?.addOnDealId;
  return normalizePositiveInteger(candidate, "identificador da campanha Shopee");
}

function buildItemPayload({ addOnDealId, itemList, itemListKey, body = {} } = {}) {
  const normalizedAddOnDealId = normalizePositiveInteger(
    addOnDealId ?? body.add_on_deal_id ?? body.addOnDealId,
    "identificador da campanha Shopee",
  );
  const resolvedItems = itemList ?? body[itemListKey];
  if (!Array.isArray(resolvedItems) || resolvedItems.length === 0) {
    throw new Error("lista de itens da campanha é obrigatória");
  }

  const { add_on_deal_id: _ignoredId, addOnDealId: _ignoredCamelId, [itemListKey]: _ignoredItems, ...extra } = body;
  return {
    ...extra,
    add_on_deal_id: normalizedAddOnDealId,
    [itemListKey]: resolvedItems,
  };
}

async function requestAddOnDeal({ shopId, path, body, operation }) {
  if (shopId == null || String(shopId).trim() === "") {
    throw new Error("shopId é obrigatório");
  }
  const payload = await requestShopeeAuthed({
    method: "post",
    path,
    shopId: String(shopId),
    body,
  });
  return ensureShopeeSuccess(payload, operation);
}

async function createGiftWithMinimumSpend({ shopId, name, startAt, endAt, minSpendCents }) {
  const raw = await requestAddOnDeal({
    shopId,
    path: "/api/v2/add_on_deal/add_add_on_deal",
    operation: "add_add_on_deal",
    body: buildGiftDealPayload({ name, startAt, endAt, minSpendCents }),
  });
  try {
    return { addOnDealId: extractAddOnDealId(raw), raw };
  } catch (error) {
    error.shopee = raw;
    throw error;
  }
}

async function addMainItems({ shopId, addOnDealId, itemList, mainItemList, body }) {
  return requestAddOnDeal({
    shopId,
    path: "/api/v2/add_on_deal/add_add_on_deal_main_item",
    operation: "add_add_on_deal_main_item",
    body: buildItemPayload({
      addOnDealId,
      itemList: mainItemList ?? itemList,
      itemListKey: "main_item_list",
      body,
    }),
  });
}

async function addGiftItems({ shopId, addOnDealId, itemList, giftItemList, subItemList, body }) {
  return requestAddOnDeal({
    shopId,
    path: "/api/v2/add_on_deal/add_add_on_deal_sub_item",
    operation: "add_add_on_deal_sub_item",
    body: buildItemPayload({
      addOnDealId,
      itemList: giftItemList ?? subItemList ?? itemList,
      itemListKey: "sub_item_list",
      body,
    }),
  });
}

async function endAddOnDeal({ shopId, addOnDealId, body = {} }) {
  const normalizedAddOnDealId = normalizePositiveInteger(
    addOnDealId ?? body.add_on_deal_id ?? body.addOnDealId,
    "identificador da campanha Shopee",
  );
  const { add_on_deal_id: _ignoredId, addOnDealId: _ignoredCamelId, ...extra } = body;
  return requestAddOnDeal({
    shopId,
    path: "/api/v2/add_on_deal/end_add_on_deal",
    operation: "end_add_on_deal",
    body: { ...extra, add_on_deal_id: normalizedAddOnDealId },
  });
}

module.exports = {
  createGiftWithMinimumSpend,
  addMainItems,
  addGiftItems,
  endAddOnDeal,
  _test: {
    buildGiftDealPayload,
    extractAddOnDealId,
  },
};
