// @ts-check
"use strict";

const { skuKey, eanKey, titleSimilarity } = require("./normalize");

/**
 * @typedef {{ id: number, skuKey: string, ean?: string | null, name?: string | null }} CatalogItem
 * @typedef {{ channelSku?: string | null, ean?: string | null, title?: string | null }} ListingInput
 * @typedef {{ itemId: number | null, method: "auto_sku" | "auto_ean" | null, suggestionItemId: number | null, reason: string }} MatchResult
 */

const SUGGESTION_MIN_SIMILARITY = 0.6;

/**
 * Índices do catálogo para casar rápido por SKU e por EAN.
 * EAN repetido em mais de um item não serve para casar (ambíguo).
 * @param {CatalogItem[]} items
 */
function buildIndex(items) {
  /** @type {Map<string, CatalogItem>} */
  const bySku = new Map();
  /** @type {Map<string, CatalogItem | null>} */
  const byEan = new Map();
  for (const item of items) {
    if (item.skuKey) bySku.set(item.skuKey, item);
    const ean = eanKey(item.ean);
    if (ean) byEan.set(ean, byEan.has(ean) ? null : item);
  }
  return { bySku, byEan, items };
}

/**
 * Decide o vínculo de um anúncio: 1) SKU igual; 2) EAN único igual;
 * 3) sem vínculo, com sugestão por título parecido (nunca vincula sozinho).
 * @param {ListingInput} listing
 * @param {ReturnType<typeof buildIndex>} index
 * @returns {MatchResult}
 */
function matchListing(listing, index) {
  const key = skuKey(listing.channelSku);
  if (key && index.bySku.has(key)) {
    return { itemId: /** @type {CatalogItem} */ (index.bySku.get(key)).id, method: "auto_sku", suggestionItemId: null, reason: "sku" };
  }
  const ean = eanKey(listing.ean);
  if (ean && index.byEan.get(ean)) {
    return { itemId: /** @type {CatalogItem} */ (index.byEan.get(ean)).id, method: "auto_ean", suggestionItemId: null, reason: "ean" };
  }
  let best = null, bestScore = 0;
  for (const item of index.items) {
    const score = titleSimilarity(listing.title, item.name);
    if (score > bestScore) { best = item; bestScore = score; }
  }
  if (best && bestScore >= SUGGESTION_MIN_SIMILARITY) {
    return { itemId: null, method: null, suggestionItemId: best.id, reason: "title_suggestion" };
  }
  return { itemId: null, method: null, suggestionItemId: null, reason: key ? "sku_not_in_catalog" : "no_sku" };
}

/**
 * Itens mestres que podem ser criados a partir dos anúncios importados:
 * um item por SKU distinto (o título mais frequente vira o nome).
 * @param {Array<ListingInput>} listings
 * @returns {Array<{ sku: string, skuKey: string, name: string | null, ean: string | null, listingCount: number }>}
 */
function deriveItemsFromListings(listings) {
  /** @type {Map<string, { sku: string, skuKey: string, names: Map<string, number>, eans: Set<string>, listingCount: number }>} */
  const groups = new Map();
  for (const listing of listings) {
    const key = skuKey(listing.channelSku);
    if (!key) continue;
    const group = groups.get(key) || { sku: String(listing.channelSku).trim(), skuKey: key, names: new Map(), eans: new Set(), listingCount: 0 };
    group.listingCount += 1;
    if (listing.title) group.names.set(listing.title, (group.names.get(listing.title) || 0) + 1);
    const ean = eanKey(listing.ean);
    if (ean) group.eans.add(ean);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const name = [...group.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    return { sku: group.sku, skuKey: group.skuKey, name, ean: group.eans.size === 1 ? [...group.eans][0] : null, listingCount: group.listingCount };
  });
}

module.exports = { buildIndex, matchListing, deriveItemsFromListings, SUGGESTION_MIN_SIMILARITY };
