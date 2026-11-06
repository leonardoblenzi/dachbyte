// @ts-check
"use strict";

const { skuKey, eanKey } = require("./normalize");
const { buildIndex, matchListing, deriveItemsFromListings } = require("./matching");

/**
 * @typedef {import("../../connectors/contract").ListingRecord} ListingRecord
 */

/**
 * Casos de uso do catálogo.
 * @param {{ repository: ReturnType<typeof import("./repository").createCatalogRepository> }} deps
 */
function createCatalogService({ repository }) {
  /**
   * Aplica um lote de anúncios de uma conta: cria os itens mestres que faltam
   * (um por SKU) e grava cada anúncio com o vínculo decidido. Usado página a página pela importação.
   * @param {{ tenantId: string, accountId: number, listings: ListingRecord[], createMissingItems?: boolean }} input
   * @returns {Promise<{ listingsSeen: number, linkedAuto: number, unlinked: number }>}
   */
  async function applyListings({ tenantId, accountId, listings, createMissingItems = true }) {
    if (!listings.length) return { listingsSeen: 0, linkedAuto: 0, unlinked: 0 };
    if (createMissingItems) {
      await repository.insertItems(tenantId, deriveItemsFromListings(listings));
    }
    const index = buildIndex(await repository.listItemsForMatching(tenantId));
    let linkedAuto = 0, unlinked = 0;
    const rows = listings.map((listing) => {
      const match = matchListing(listing, index);
      if (match.itemId) linkedAuto += 1; else unlinked += 1;
      return {
        listing_id: listing.listingId,
        variation_id: listing.variationId || "",
        channel_sku: listing.channelSku || null,
        sku_key: skuKey(listing.channelSku),
        ean: eanKey(listing.ean),
        title: listing.title || null,
        status: listing.status || null,
        fulfillment: Boolean(listing.fulfillment),
        channel_stock: listing.stock == null ? null : Number(listing.stock),
        price: listing.price == null ? null : Number(listing.price),
        item_id: match.itemId,
        link_method: match.method,
        suggestion_item_id: match.suggestionItemId,
      };
    });
    await repository.upsertListings(accountId, rows);
    return { listingsSeen: listings.length, linkedAuto, unlinked };
  }

  /**
   * Importa um lote único já em memória, com registro de execução próprio (planilha, testes).
   * @param {{ tenantId: string, accountId: number, listings: ListingRecord[], createMissingItems?: boolean }} input
   */
  async function importListings(input) {
    const run = await repository.startImportRun(input.accountId);
    try {
      const result = { status: "succeeded", ...(await applyListings(input)) };
      await repository.finishImportRun(run.id, result);
      return { runId: run.id, ...result };
    } catch (error) {
      await repository.finishImportRun(run.id, { status: "failed", error: String(/** @type {Error} */ (error).message || error).slice(0, 500) });
      throw error;
    }
  }

  return {
    applyListings,
    importListings,
    /** @param {string} tenantId */
    overview: (tenantId) => repository.overview(tenantId),
    /** @param {string} tenantId @param {{ q?: string, limit?: number, offset?: number }} [options] */
    listItems: (tenantId, options) => repository.listItems(tenantId, options),
    /** @param {string} tenantId @param {{ limit?: number, offset?: number }} [options] */
    listPending: (tenantId, options) => repository.listUnlinked(tenantId, options),
    /** @param {string} tenantId @param {number} listingId @param {number} itemId */
    async linkListing(tenantId, listingId, itemId) {
      const linked = await repository.linkManually(tenantId, listingId, itemId);
      if (!linked) throw Object.assign(new Error("Anúncio ou produto não encontrado nesta empresa."), { status: 404 });
      return linked;
    },
  };
}

module.exports = { createCatalogService };
