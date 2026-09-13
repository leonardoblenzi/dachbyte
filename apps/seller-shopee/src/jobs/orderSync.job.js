// src/jobs/orderSync.job.js
const OrderSyncService = require("../services/OrderSyncService");
const {
  findShopByDbIdOrShopeeShopId,
  listShopsWithOrderTokens,
} = require("../repositories/operationsSqlRepository");

function getAutoRangeDays() {
  const raw = Number(process.env.ORDER_SYNC_AUTO_RANGE_DAYS || 3);
  if (!Number.isFinite(raw)) return 3;
  return Math.min(Math.max(Math.floor(raw), 1), 30);
}

async function syncAllShops(rangeDays) {
  const shops = await listShopsWithOrderTokens();

  const results = [];
  for (const shop of shops) {
    if (!shop?.shopId) continue;

    const shopeeShopId = String(shop.shopId);

    try {
      const result = await OrderSyncService.syncOrdersForShop({
        shopeeShopId,
        rangeDays,
      });
      results.push({
        shopIdInternal: shop.id,
        shopeeShopId,
        ok: true,
        result,
      });
    } catch (error) {
      results.push({
        shopIdInternal: shop.id,
        shopeeShopId,
        ok: false,
        error: String(error?.message || error),
      });
    }
  }

  return {
    mode: "all_shops",
    rangeDays,
    totalShops: results.length,
    ok: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    shops: results,
  };
}

module.exports = async (job) => {
  const { shopId, rangeDays, syncAllShops: shouldSyncAllShops } = job.data || {};

  if (shouldSyncAllShops || job?.name === "sync_all_shops") {
    const autoRangeDays = OrderSyncService.parseRangeDays(
      rangeDays ?? getAutoRangeDays(),
    );

    console.log("[orderSync] start all shops", {
      jobId: job.id,
      rangeDays: autoRangeDays,
    });

    return syncAllShops(autoRangeDays);
  }

  const shop = await findShopByDbIdOrShopeeShopId(shopId);

  if (!shop) {
    throw new Error(`Shop não encontrado para shopId=${shopId}`);
  }

  console.log("[orderSync] start", {
    jobId: job.id,
    shopIdInternal: shop.id,
    shopeeShopId: String(shop.shopId),
    rangeDays,
  });

  return OrderSyncService.syncOrdersForShop({
    shopeeShopId: String(shop.shopId),
    rangeDays,
  });
};
