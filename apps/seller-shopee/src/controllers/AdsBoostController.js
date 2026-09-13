const { resolveShop } = require("../utils/resolveShop");
const ProductBoostService = require("../services/ProductBoostService");

async function overview(req, res) {
  const shop = await resolveShop(req, "active");
  const result = await ProductBoostService.getOverview({
    shop,
    dateFrom: req.query?.dateFrom,
    dateTo: req.query?.dateTo,
  });

  return res.json(result);
}

async function run(req, res) {
  const shop = await resolveShop(req, "active");
  const itemIds = Array.isArray(req.body?.itemIds) ? req.body.itemIds : [];

  const result = await ProductBoostService.runBoost({
    shop,
    userId: req.auth?.userId || null,
    itemIds,
  });

  return res.json(result);
}

module.exports = {
  overview,
  run,
};
