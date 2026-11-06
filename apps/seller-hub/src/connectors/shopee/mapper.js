// @ts-check
"use strict";

/** @typedef {import("../contract").ListingRecord} ListingRecord */

/** @param {unknown} value */
function text(value) { return String(value == null ? "" : value).trim(); }
/** @param {unknown} value */
function num(value) { const n = Number(value); return value == null || !Number.isFinite(n) ? null : n; }

/** Estoque disponível (stock_info_v2.summary_info.total_available_stock). @param {any} node */
function availableStock(node) {
  return num(node?.stock_info_v2?.summary_info?.total_available_stock);
}

/** Preço atual (price_info[0].current_price). @param {any} node */
function currentPrice(node) {
  return num(Array.isArray(node?.price_info) ? node.price_info[0]?.current_price : null);
}

/**
 * Converte item (get_item_base_info) + modelos (get_model_list) em registros do Hub.
 * Item sem modelo = um registro; com modelos = um por model_id.
 * @param {any} item @param {any[]} [models] @returns {ListingRecord[]}
 */
function mapItem(item, models = []) {
  if (!item || item.item_id == null) return [];
  const base = {
    listingId: String(item.item_id),
    title: text(item.item_name) || null,
    status: text(item.item_status) || null,
    fulfillment: false,
  };
  const list = Array.isArray(models) ? models : [];
  if (!item.has_model || !list.length) {
    return [{ ...base, variationId: "", channelSku: text(item.item_sku) || null, ean: text(item.gtin_code) || null, stock: availableStock(item), price: currentPrice(item) }];
  }
  return list.map((model) => ({
    ...base,
    variationId: String(model.model_id),
    channelSku: text(model.model_sku) || text(item.item_sku) || null,
    ean: text(model.gtin_code) || text(item.gtin_code) || null,
    stock: availableStock(model),
    price: currentPrice(model),
  }));
}

module.exports = { mapItem, availableStock, currentPrice };
