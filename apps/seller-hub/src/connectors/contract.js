// @ts-check
"use strict";

/**
 * Formato único de anúncio dentro do Hub, igual para todos os marketplaces.
 * Um registro por variação vendável (anúncio sem variação = um registro).
 * @typedef {{
 *   listingId: string,
 *   variationId?: string,
 *   channelSku?: string | null,
 *   ean?: string | null,
 *   title?: string | null,
 *   status?: string | null,
 *   stock?: number | null,
 *   price?: number | null,
 *   fulfillment?: boolean,
 * }} ListingRecord
 *
 * @typedef {{ id: number, externalAccountId: string, accessToken: string }} ConnectedAccount
 */

/** Canais suportados nesta fase. */
const CHANNELS = Object.freeze(["mercadolivre", "magalu", "shopee"]);

/**
 * Contrato que todo conector de marketplace cumpre (portas e adaptadores).
 * O núcleo do Hub só conhece estes métodos; cada marketplace implementa do seu jeito.
 */
class MarketplaceConnector {
  /** @returns {string} */
  get channel() { throw new Error("channel não implementado"); }
  /** URL de autorização do seller. @param {{ state: string, redirectUri: string }} _input @returns {string} */
  authorizeUrl(_input) { throw new Error("authorizeUrl não implementado"); }
  /** Troca o código por tokens. @param {{ code: string, redirectUri: string }} _input @returns {Promise<any>} */
  async exchangeCode(_input) { throw new Error("exchangeCode não implementado"); }
  /** Renova o token (no ML o refresh é de uso único). @param {{ refreshToken: string }} _input @returns {Promise<any>} */
  async refresh(_input) { throw new Error("refresh não implementado"); }
  /** Página de anúncios da conta. @param {ConnectedAccount} _account @param {{ cursor?: string | null }} _options
   *  @returns {Promise<{ listings: ListingRecord[], nextCursor: string | null }>} */
  async listListings(_account, _options) { throw new Error("listListings não implementado"); }
}

/**
 * Confere se um registro respeita o formato comum (usado nos testes de contrato).
 * @param {any} record @returns {string[]} lista de problemas (vazia = ok)
 */
function validateListingRecord(record) {
  const problems = [];
  if (!record || typeof record !== "object") return ["registro não é objeto"];
  if (!record.listingId || typeof record.listingId !== "string") problems.push("listingId ausente");
  if (record.variationId != null && typeof record.variationId !== "string") problems.push("variationId deve ser texto");
  for (const field of ["stock", "price"]) {
    if (record[field] != null && !Number.isFinite(record[field])) problems.push(`${field} deve ser número`);
  }
  if (record.fulfillment != null && typeof record.fulfillment !== "boolean") problems.push("fulfillment deve ser booleano");
  return problems;
}

module.exports = { MarketplaceConnector, CHANNELS, validateListingRecord };
