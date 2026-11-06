// @ts-check
"use strict";

/**
 * Formato único de anúncio dentro do Hub, igual para todos os canais.
 * Um registro por variação vendável (anúncio sem variação = um registro).
 * Em loja virtual: listingId = id do produto na loja, variationId = id da variante.
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

/**
 * Contrato que todo conector de canal cumpre — marketplace ou loja virtual (portas e adaptadores).
 * O núcleo do Hub só conhece estes métodos; cada canal implementa do seu jeito.
 * A lista de canais fica em ./channels.js.
 */
class ChannelConnector {
  /** @returns {string} */
  get channel() { throw new Error("channel não implementado"); }
  /** App/credenciais do Hub configurados para este canal. @returns {boolean} */
  get configured() { return false; }
  /** URL de autorização do seller. @param {{ state: string, redirectUri: string }} _input @returns {string} */
  authorizeUrl(_input) { throw new Error("authorizeUrl não implementado"); }
  /** Troca o código por tokens (a Shopee manda também o shop_id). @param {{ code: string, redirectUri: string, shopId?: string | number }} _input @returns {Promise<any>} */
  async exchangeCode(_input) { throw new Error("exchangeCode não implementado"); }
  /** Renova o token (no ML o refresh é de uso único). @param {{ refreshToken: string, externalAccountId?: string }} _input @returns {Promise<any>} */
  async refresh(_input) { throw new Error("refresh não implementado"); }
  /**
   * Conexão por formulário (lojas virtuais com chave de API/URL da loja). Valida as
   * credenciais no canal e devolve os mesmos { tokens, account } do OAuth.
   * @param {Record<string, string>} _fields @returns {Promise<any>}
   */
  async connectWithCredentials(_fields) { throw new Error("connectWithCredentials não implementado"); }
  /**
   * Valida e lê uma notificação do canal (assinatura/origem). Lança erro 401 se não for autêntica.
   * @param {{ headers: Record<string, any>, rawBody: Buffer, url: string, secrets?: string[] }} _input
   * @returns {{ events: Array<{ externalAccountId: string, topic: string, resourceId: string, dedupeKey: string, payload?: any }> }}
   */
  parseWebhook(_input) { throw new Error("parseWebhook não implementado"); }
  /*
   * Opcionais, para canais em que cada seller assina os avisos com o próprio token e recebe um segredo (Magalu):
   *   subscribeWebhooks(account, { url }) → { secrets, topics }  (um segredo por tópico)   chamado ao conectar a conta (e pelo botão "Assinar avisos");
   *   webhookAccountId(rawBody) → string | null                  conta do aviso, para o Hub buscar o segredo dela;
   *   parseWebhook recebe então { ..., secrets: string[] }.
   */
  /** Pedido atualizado no canal (null se não existir). @param {ConnectedAccount} _account @param {string} _orderId @returns {Promise<any>} */
  async getOrder(_account, _orderId) { throw new Error("getOrder não implementado"); }
  /** Pedidos atualizados desde uma data, paginados. @param {ConnectedAccount} _account @param {{ updatedFrom: Date, cursor?: string | null }} _options
   *  @returns {Promise<{ orders: any[], nextCursor: string | null }>} */
  async listOrders(_account, _options) { throw new Error("listOrders não implementado"); }
  /**
   * Grava estoque. Para cada item: ok, retryable (não gravou; tentar depois), uncertain (pode ter gravado; conferir) ou erro.
   * @param {ConnectedAccount} _account @param {Array<{ ref: number, listingId: string, variationId: string, quantity: number }>} _writes
   * @returns {Promise<Array<{ ref: number, ok: boolean, retryable?: boolean, uncertain?: boolean, error?: string }>>}
   */
  async writeStock(_account, _writes) { throw new Error("writeStock não implementado"); }
  /**
   * Etiquetas de envio (PDF ou ZPL) dos pedidos. Devolve os arquivos do canal e o resultado por pedido.
   * @param {ConnectedAccount} _account @param {Array<{ ref: number, orderId: string, shipmentId?: string | null, trackingCode?: string | null, refs?: any }>} _refs
   * @param {{ format: "pdf" | "zpl" }} _options
   * @returns {Promise<{ files: Array<{ contentType: string, buffer: Buffer, extension: string, orders: number }>, results: Array<{ ref: number, ok: boolean, error?: string, trackingCode?: string | null }> }>}
   */
  async fetchLabels(_account, _refs, _options) { throw new Error("fetchLabels não implementado"); }
  /** Relê o estoque no canal (conferência). @param {ConnectedAccount} _account @param {Array<{ ref: number, listingId: string, variationId: string }>} _refs
   *  @returns {Promise<Array<{ ref: number, stock: number | null }>>} */
  async readStock(_account, _refs) { throw new Error("readStock não implementado"); }
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

module.exports = { ChannelConnector, validateListingRecord };
