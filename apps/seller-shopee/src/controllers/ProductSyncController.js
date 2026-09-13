// src/controllers/ProductSyncController.js
const { syncProductsForShop } = require("../services/ProductSyncService");
const { resolveShop } = require("../utils/resolveShop");

async function sync(req, res, next) {
  try {
    const shopParam = String(req.params.shopId || "active");
    const shop = await resolveShop(req, shopParam); // { id (DB), shopId (Shopee BigInt) }

    const result = await syncProductsForShop({
      shopeeShopId: String(shop.shopId), // ✅ Shopee shop_id
    });

    return res.json(result);
  } catch (e) {
    return next(e);
  }
}

module.exports = { sync };
