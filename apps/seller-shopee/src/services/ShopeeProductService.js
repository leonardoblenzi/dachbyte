const { requestShopeeAuthed } = require("./ShopeeAuthedHttp");

async function getItemList({
  shopId,
  offset,
  pageSize,
  itemStatus = "NORMAL",
}) {
  return requestShopeeAuthed({
    method: "get",
    path: "/api/v2/product/get_item_list",
    shopId: String(shopId),
    query: { offset, page_size: pageSize, item_status: itemStatus },
  });
}

async function getItemBaseInfo({ shopId, itemIdList, needTaxInfo = true }) {
  const normalizedIds = Array.isArray(itemIdList)
    ? itemIdList.map((value) => String(value || "").trim()).filter(Boolean)
    : String(itemIdList || "")
        .split(",")
        .map((value) => String(value || "").trim())
        .filter(Boolean);

  return requestShopeeAuthed({
    method: "get",
    path: "/api/v2/product/get_item_base_info",
    shopId: String(shopId),
    query: {
      item_id_list: normalizedIds.join(","),
      need_tax_info: Boolean(needTaxInfo),
    },
  });
}

async function getModelList({ shopId, itemId }) {
  return requestShopeeAuthed({
    method: "get",
    path: "/api/v2/product/get_model_list",
    shopId: String(shopId),
    query: { item_id: String(itemId) },
  });
}

async function getItemExtraInfo({ shopId, itemId }) {
  const itemIdList = Array.isArray(itemId)
    ? itemId
    : itemId != null
      ? [itemId]
      : [];
  const normalizedItemIdList = itemIdList
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .slice(0, 50)
    .join(",");

  return requestShopeeAuthed({
    method: "get",
    path: "/api/v2/product/get_item_extra_info",
    shopId: String(shopId),
    query: { item_id_list: normalizedItemIdList },
  });
}

async function getItemExtraInfoBatch({ shopId, itemIdList }) {
  const normalizedItemIdList = Array.isArray(itemIdList)
    ? itemIdList.map((value) => String(value || "").trim()).filter(Boolean).slice(0, 50).join(",")
    : String(itemIdList || "").trim();

  return requestShopeeAuthed({
    method: "get",
    path: "/api/v2/product/get_item_extra_info",
    shopId: String(shopId),
    query: { item_id_list: normalizedItemIdList },
  });
}

async function getAttributes({ shopId, categoryId }) {
  return requestShopeeAuthed({
    method: "get",
    path: "/api/v2/product/get_attributes",
    shopId: String(shopId),
    query: { category_id: String(categoryId) },
  });
}

async function getAttributeTree({ shopId, categoryId, language = "pt-BR" }) {
  return requestShopeeAuthed({
    method: "get",
    path: "/api/v2/product/get_attribute_tree",
    shopId: String(shopId),
    query: {
      category_id: String(categoryId),
      language: String(language || "pt-BR"),
    },
  });
}
async function getCategoryTree({ shopId, language = "pt-br" }) {
  return requestShopeeAuthed({
    method: "get",
    path: "/api/v2/product/get_category",
    shopId: String(shopId),
    query: { language: String(language || "pt-br") },
  });
}

async function getBoostedList({ shopId }) {
  return requestShopeeAuthed({
    method: "get",
    path: "/api/v2/product/get_boosted_list",
    shopId: String(shopId),
    query: {},
  });
}

module.exports = {
  getBoostedList,
  getCategoryTree,
  getAttributeTree,
  getItemList,
  getItemBaseInfo,
  getModelList,
  getItemExtraInfo,
  getItemExtraInfoBatch,
  getAttributes,
};
