"use strict";

const ml = require("./mercadoLivreApi");
const { httpError } = require("./helpers");

const cache = new Map();
const CACHE_MS = 5 * 60 * 1000;

async function getCapabilities(ctx, { force = false } = {}) {
  if (!ctx.sellerId) throw httpError("A conta Mercado Livre selecionada não possui seller_id.", 409);
  const key = `${ctx.meliContaId || "x"}:${ctx.sellerId}`;
  const current = cache.get(key);
  if (!force && current && current.expiresAt > Date.now()) return current.value;

  const user = await ml.get(`/users/${encodeURIComponent(ctx.sellerId)}`, { accessToken: ctx.accessToken });
  const tags = Array.isArray(user?.tags) ? user.tags.map(String) : [];
  const value = {
    seller_id: ctx.sellerId,
    site_id: ctx.siteId,
    nickname: user?.nickname || null,
    publication_model: tags.includes("user_product_seller") ? "user_products" : "legacy",
    user_product_seller: tags.includes("user_product_seller"),
    tags,
  };
  cache.set(key, { value, expiresAt: Date.now() + CACHE_MS });
  return value;
}

module.exports = { getCapabilities };
