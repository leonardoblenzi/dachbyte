// @ts-check
"use strict";

/** @typedef {import("../contract").ListingRecord} ListingRecord */

/** @param {unknown} value */
function text(value) { return String(value == null ? "" : value).trim(); }
/** @param {unknown} value */
function num(value) { const n = Number(value); return value == null || !Number.isFinite(n) ? null : n; }

/** EAN do SKU Magalu (campo direto ou lista de identificadores). @param {any} sku */
function skuEan(sku) {
  const direct = text(sku?.ean || sku?.gtin);
  if (direct) return direct;
  const ids = Array.isArray(sku?.identifiers) ? sku.identifiers : [];
  const found = ids.find((id) => /^(ean|gtin)/i.test(text(id?.type)));
  return found ? text(found.value) || null : null;
}

/** Preço do retorno de /portfolios/prices (inteiro com normalizer). @param {any} payload */
function priceFrom(payload) {
  const result = Array.isArray(payload?.results) ? payload.results[0] : payload;
  const normalizer = Number(result?.normalizer);
  const price = num(result?.price);
  if (price == null) return null;
  return Number.isFinite(normalizer) && normalizer > 0 ? price / normalizer : price;
}

/** Estoque disponível somando os resultados AVAILABLE (RESERVED não conta). @param {any} payload */
function stockFrom(payload) {
  if (!Array.isArray(payload?.results)) return num(payload?.quantity ?? payload?.available_quantity);
  let total = 0, seen = 0;
  for (const row of payload.results) {
    if (text(row?.type).toUpperCase() !== "AVAILABLE") continue;
    const q = num(row?.quantity);
    if (q == null || q < 0) continue;
    total += q; seen += 1;
  }
  return seen ? total : null;
}

/**
 * Converte SKU + preço + estoque do portfólio Magalu num registro do Hub.
 * No Magalu cada variação já é um SKU próprio.
 * @param {{ sku: any, price?: any, stock?: any }} input @returns {ListingRecord | null}
 */
function mapSku({ sku, price, stock }) {
  const code = text(sku?.sku);
  if (!code) return null;
  return {
    listingId: code,
    variationId: "",
    channelSku: code,
    ean: skuEan(sku),
    title: text(sku?.title) || null,
    status: text(sku?.status) || null,
    fulfillment: sku?.fulfillment === true,
    stock: stockFrom(stock),
    price: priceFrom(price),
  };
}

module.exports = { mapSku, priceFrom, stockFrom, skuEan };
