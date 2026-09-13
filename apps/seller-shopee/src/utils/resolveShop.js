const { findShopForAccountById } = require("../repositories/runtimeSqlRepository");
const {
  listShopsByAccountId,
  updateSessionActiveShopId,
} = require("../repositories/authSqlRepository");

async function resolveFallbackActiveShop(req, accountId) {
  const shops = await listShopsByAccountId(accountId, 1);
  const fallbackShop = Array.isArray(shops) && shops.length ? shops[0] : null;
  if (!fallbackShop) return null;

  const fallbackShopId = Number(fallbackShop.id);
  if (!Number.isFinite(fallbackShopId)) return null;

  if (req?.auth) {
    req.auth.activeShopId = fallbackShopId;
  }

  if (req?.auth?.sid) {
    updateSessionActiveShopId(req.auth.sid, fallbackShopId).catch(() => {});
  }

  return findShopForAccountById(fallbackShopId, accountId);
}

async function resolveShop(req, shopIdParam) {
  const accountId = req.auth?.accountId ?? null;
  const activeShopId = req.auth?.activeShopId ?? null;

  if (!accountId) {
    const err = new Error("Nao autenticado.");
    err.statusCode = 401;
    throw err;
  }

  if (String(shopIdParam) === "active") {
    let shop = null;

    if (activeShopId) {
      shop = await findShopForAccountById(Number(activeShopId), accountId);
    }

    if (!shop) {
      shop = await resolveFallbackActiveShop(req, accountId);
    }

    if (!shop) {
      const err = new Error("Nenhuma loja encontrada para esta conta.");
      err.statusCode = 404;
      throw err;
    }

    return shop; // id (DB), shopId (Shopee BigInt)
  }

  const dbShopId = Number(shopIdParam);
  if (!Number.isFinite(dbShopId)) {
    const err = new Error("shopId invalido.");
    err.statusCode = 400;
    throw err;
  }

  const shop = await findShopForAccountById(dbShopId, accountId);

  if (!shop) {
    const err = new Error("Loja nao encontrada para esta conta.");
    err.statusCode = 404;
    throw err;
  }

  return shop;
}

module.exports = { resolveShop };
