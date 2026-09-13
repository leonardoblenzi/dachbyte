const ShopeeProductService = require("./ShopeeProductService");
const ShopeeProductWriteService = require("./ShopeeProductWriteService");

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function getProductsBaseInfo({ shopId, itemIds }) {
  const ids = Array.isArray(itemIds)
    ? itemIds.map((value) => String(value || "").trim()).filter(Boolean)
    : [];

  const results = [];

  for (const batch of chunk(ids, 20)) {
    const response = await ShopeeProductService.getItemBaseInfo({
      shopId: String(shopId),
      itemIdList: batch,
    });

    const items =
      response?.response?.item_list ||
      response?.response?.items ||
      response?.response ||
      [];

    if (Array.isArray(items)) {
      results.push(...items);
    }
  }

  return results;
}

async function updateProductLogistics({ shopId, itemId, logistics }) {
  return ShopeeProductWriteService.updateItem({
    shopId: String(shopId),
    body: {
      item_id: Number(itemId),
      logistic_info: Array.isArray(logistics) ? logistics : [],
    },
  });
}

module.exports = {
  getProductsBaseInfo,
  updateProductLogistics,
};
