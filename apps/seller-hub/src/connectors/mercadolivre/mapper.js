// @ts-check
"use strict";

/** @typedef {import("../contract").ListingRecord} ListingRecord */

/** @param {any[]} attributes @param {string} id */
function attributeValue(attributes, id) {
  const found = (Array.isArray(attributes) ? attributes : []).find((attr) => attr && attr.id === id);
  const value = found && (found.value_name ?? found.values?.[0]?.name);
  return value == null || value === "" ? null : String(value).trim();
}

/** @param {unknown} value */
function num(value) { const n = Number(value); return value == null || !Number.isFinite(n) ? null : n; }

/**
 * SKU de um anúncio ou variação no ML: seller_custom_field, seller_sku ou atributo SELLER_SKU
 * (mesma ordem usada no DACH ML). @param {any} node
 */
function sellerSku(node) {
  const direct = node?.seller_custom_field ?? node?.seller_sku;
  if (direct != null && String(direct).trim()) return String(direct).trim();
  return attributeValue(node?.attributes, "SELLER_SKU");
}

/**
 * Converte o corpo de GET /items/{id} em registros do Hub (um por variação).
 * Full (logistic_type=fulfillment) vem marcado e nunca recebe escrita.
 * @param {any} item @returns {ListingRecord[]}
 */
function mapItem(item) {
  if (!item || !item.id) return [];
  const fulfillment = String(item.shipping?.logistic_type || "").toLowerCase() === "fulfillment";
  const base = {
    listingId: String(item.id),
    title: item.title ? String(item.title) : null,
    status: item.status ? String(item.status) : null,
    fulfillment,
  };
  const variations = Array.isArray(item.variations) ? item.variations : [];
  if (!variations.length) {
    return [{
      ...base, variationId: "",
      channelSku: sellerSku(item),
      ean: attributeValue(item.attributes, "GTIN"),
      stock: num(item.available_quantity),
      price: num(item.price),
    }];
  }
  return variations.map((variation) => ({
    ...base,
    variationId: String(variation.id),
    channelSku: sellerSku(variation) || sellerSku(item),
    ean: attributeValue(variation.attributes, "GTIN") || attributeValue(item.attributes, "GTIN"),
    stock: num(variation.available_quantity),
    price: num(variation.price ?? item.price),
  }));
}

/** Resposta de GET /items?ids=... (lote de até 20). @param {any[]} body */
function mapItemsBatch(body) {
  return (Array.isArray(body) ? body : []).filter((entry) => entry && entry.code === 200).flatMap((entry) => mapItem(entry.body));
}

module.exports = { mapItem, mapItemsBatch, sellerSku, attributeValue };
