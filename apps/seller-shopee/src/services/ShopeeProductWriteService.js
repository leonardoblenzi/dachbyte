const { requestShopeeAuthed } = require("./ShopeeAuthedHttp");

function hasShopeeError(payload) {
  const raw = payload?.error;
  if (raw == null) return false;
  if (raw === 0 || raw === "0") return false;
  if (typeof raw === "string" && raw.trim() === "") return false;
  return true;
}

function ensureShopeeWriteSuccess(payload, operation) {
  if (!hasShopeeError(payload)) return payload;
  const errorCode = String(payload?.error || "shopee_error");
  const message = String(payload?.message || payload?.warning || "").trim();
  const err = new Error(
    `${operation} falhou${message ? `: ${message}` : ""} (${errorCode})`,
  );
  err.shopee = payload;
  throw err;
}

function shouldTryAlternativePayload(error) {
  const code = String(error?.shopee?.error || "").toLowerCase();
  const message = String(error?.shopee?.message || error?.message || "").toLowerCase();
  return (
    code.includes("error_param") ||
    message.includes("all failed") ||
    message.includes("invalid")
  );
}

async function requestWithFallback({
  shopId,
  path,
  operation,
  primaryBody,
  fallbackBodies = [],
}) {
  const bodies = [primaryBody, ...(Array.isArray(fallbackBodies) ? fallbackBodies : [])];
  let lastError = null;

  for (let i = 0; i < bodies.length; i += 1) {
    const body = bodies[i];
    try {
      const payload = await requestShopeeAuthed({
        method: "post",
        path,
        shopId: String(shopId),
        body,
      });
      return ensureShopeeWriteSuccess(payload, operation);
    } catch (error) {
      lastError = error;
      const hasNext = i < bodies.length - 1;
      if (!hasNext || !shouldTryAlternativePayload(error)) {
        throw error;
      }
    }
  }

  throw lastError || new Error(`${operation} falhou`);
}

async function updateItem({ shopId, body }) {
  const payload = await requestShopeeAuthed({
    method: "post",
    path: "/api/v2/product/update_item",
    shopId: String(shopId),
    body,
  });
  return ensureShopeeWriteSuccess(payload, "update_item");
}
async function updatePrice({ shopId, body }) {
  const payload = await requestShopeeAuthed({
    method: "post",
    path: "/api/v2/product/update_price",
    shopId: String(shopId),
    body,
  });
  return ensureShopeeWriteSuccess(payload, "update_price");
}
async function updateStock({ shopId, body }) {
  const payload = await requestShopeeAuthed({
    method: "post",
    path: "/api/v2/product/update_stock",
    shopId: String(shopId),
    body,
  });
  return ensureShopeeWriteSuccess(payload, "update_stock");
}

async function addItem({ shopId, body }) {
  const payload = await requestShopeeAuthed({
    method: "post",
    path: "/api/v2/product/add_item",
    shopId: String(shopId),
    body,
  });
  return ensureShopeeWriteSuccess(payload, "add_item");
}

async function initTierVariation({ shopId, body }) {
  const payload = await requestShopeeAuthed({
    method: "post",
    path: "/api/v2/product/init_tier_variation",
    shopId: String(shopId),
    body,
  });
  return ensureShopeeWriteSuccess(payload, "init_tier_variation");
}

async function boostItems({ shopId, body }) {
  const payload = await requestShopeeAuthed({
    method: "post",
    path: "/api/v2/product/boost_item",
    shopId: String(shopId),
    body,
  });
  return ensureShopeeWriteSuccess(payload, "boost_item");
}

function buildUnlistItemBody(body = {}) {
  const itemId = Number(body.item_id ?? body.itemId);
  if (!Number.isSafeInteger(itemId) || itemId <= 0) {
    throw new Error("item_id invalido para unlist_item");
  }

  return {
    item_list: [
      {
        item_id: itemId,
        unlist: body.unlist ?? true,
      },
    ],
  };
}

async function unlistItem({ shopId, body }) {
  return requestWithFallback({
    shopId,
    path: "/api/v2/product/unlist_item",
    operation: "unlist_item",
    primaryBody: buildUnlistItemBody(body),
  });
}

async function deleteItem({ shopId, body }) {
  const itemId = Number(body?.item_id ?? body?.itemId);
  const normalizedItemId = Number.isFinite(itemId) ? itemId : body?.item_id;
  return requestWithFallback({
    shopId,
    path: "/api/v2/product/delete_item",
    operation: "delete_item",
    primaryBody: {
      ...body,
      item_id: normalizedItemId,
    },
    fallbackBodies: [
      { item_id_list: [normalizedItemId] },
      { item_list: [{ item_id: normalizedItemId }] },
    ],
  });
}

module.exports = {
  addItem,
  boostItems,
  initTierVariation,
  updateItem,
  updatePrice,
  updateStock,
  unlistItem,
  deleteItem,
  _test: {
    buildUnlistItemBody,
  },
};
