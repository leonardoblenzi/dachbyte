const { findShopForAccountById } = require("../repositories/runtimeSqlRepository");

async function resolveShopeeShopIdParam(req, res, next) {
  try {
    const raw = String(req.params.shopId || "").trim();

    // Caso 1: /shops/active/...
    if (raw === "active") {
      const activeShopDbId = req.auth?.activeShopId;
      const accountId = req.auth?.accountId;

      if (!activeShopDbId || !accountId) {
        return res
          .status(401)
          .json({ error: "unauthorized", message: "Não autenticado." });
      }

      const shop = await findShopForAccountById(activeShopDbId, accountId);

      if (!shop) {
        return res.status(404).json({ error: "shop_not_found" });
      }

      req.shopeeShopId = shop.shopId; // BigInt
      req.shopDbId = shop.id; // Int
      return next();
    }

    // Caso 2: /shops/:shopId/... com shopId numérico (Shopee)
    let shopeeShopId;
    try {
      shopeeShopId = BigInt(raw);
    } catch {
      return res
        .status(400)
        .json({
          error: {
            message: "shopId inválido (não foi possível converter para BigInt)",
          },
        });
    }

    req.shopeeShopId = shopeeShopId;
    return next();
  } catch (e) {
    return next(e);
  }
}

module.exports = { resolveShopeeShopIdParam };
