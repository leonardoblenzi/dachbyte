// @ts-check
"use strict";

const { MercadoLivreConnector } = require("./mercadolivre/MercadoLivreConnector");
const { MagaluConnector } = require("./magalu/MagaluConnector");
const { ShopeeConnector } = require("./shopee/ShopeeConnector");

const LABELS = { mercadolivre: "Mercado Livre", magalu: "Magalu", shopee: "Shopee" };

/**
 * Cria os conectores a partir da configuração do Hub (apps próprios em cada marketplace).
 * @param {{ mercadolivre: { clientId: string, clientSecret: string }, magalu: { clientId: string, clientSecret: string, scopes: string[] }, shopee: { partnerId: string, partnerKey: string, apiBase: string } }} channels
 * @param {typeof fetch} [fetchImpl]
 */
function createConnectors(channels, fetchImpl = fetch) {
  /** @type {Record<string, any>} */
  const connectors = {
    mercadolivre: new MercadoLivreConnector({ ...channels.mercadolivre, fetchImpl }),
    magalu: new MagaluConnector({ ...channels.magalu, fetchImpl }),
    shopee: new ShopeeConnector({ ...channels.shopee, fetchImpl }),
  };
  return {
    /** @param {string} channel */
    get(channel) {
      const connector = connectors[channel];
      if (!connector) throw Object.assign(new Error("Canal desconhecido."), { status: 404 });
      return connector;
    },
    list() {
      return Object.values(connectors).map((connector) => ({
        id: connector.channel,
        label: LABELS[/** @type {keyof typeof LABELS} */ (connector.channel)],
        available: Boolean(connector.configured),
      }));
    },
  };
}

module.exports = { createConnectors, LABELS };
