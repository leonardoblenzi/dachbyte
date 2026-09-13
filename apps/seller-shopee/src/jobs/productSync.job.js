// src/jobs/productSync.job.js
const ProductSyncService = require("../services/ProductSyncService");

module.exports = async (job) => {
  const { shopId } = job.data;

  console.log("[productSync] start", { jobId: job.id, shopId });

  const result = await ProductSyncService.syncProductsForShop({
    shopeeShopId: shopId,
    onProgress: (progress) => job.updateProgress(progress),
  });

  console.log("[productSync] done", { jobId: job.id, shopId, result });
  return result;
};
