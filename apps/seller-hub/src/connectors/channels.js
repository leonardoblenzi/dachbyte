// @ts-check
"use strict";

/**
 * Catálogo de canais do DACH Hub: o único lugar que lista os canais.
 *
 * Para adicionar um marketplace ou uma loja virtual (ex.: Amazon, Americanas,
 * Nuvemshop, Shopify, WooCommerce, VTEX):
 *   1. crie `src/connectors/<canal>/` com o conector (estende ChannelConnector) e o mapper;
 *   2. acrescente uma definição abaixo (tipo, forma de conexão, capacidades e variáveis de ambiente);
 *   3. rode os testes de contrato (tests/connectors-contract.test.js).
 * Banco, telas, rotas e fila não mudam: tudo lê esta lista.
 */

const { MercadoLivreConnector } = require("./mercadolivre/MercadoLivreConnector");
const { MagaluConnector } = require("./magalu/MagaluConnector");
const { ShopeeConnector } = require("./shopee/ShopeeConnector");

/** @typedef {"marketplace" | "store"} ChannelKind */
/**
 * "oauth" = o seller autoriza no site do canal e volta para o Hub.
 * "credentials" = o seller informa chaves/URL da loja num formulário (comum em lojas virtuais).
 * @typedef {"oauth" | "credentials"} ChannelAuth
 */
/**
 * O que o canal sabe fazer. O núcleo consulta isto antes de agendar trabalho
 * (ex.: não envia estoque para canal sem `stockWrite`).
 * labels: o Hub baixa a etiqueta de envio do canal.
 * @typedef {{ listings: boolean, stockWrite: boolean, priceWrite: boolean, orders: boolean, fulfillment: boolean, labels?: boolean }} ChannelCapabilities
 */
/** @typedef {{ name: string, label: string, type?: "text" | "password" | "url", placeholder?: string }} CredentialField */
/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   kind: ChannelKind,
 *   auth: ChannelAuth,
 *   capabilities: ChannelCapabilities,
 *   credentialFields?: CredentialField[],
 *   settingsFromEnv: (env: Record<string, string | undefined>) => Record<string, any>,
 *   create: (settings: Record<string, any>, fetchImpl: typeof fetch) => import("./contract").ChannelConnector,
 * }} ChannelDefinition
 */

const CHANNEL_KINDS = Object.freeze(/** @type {ChannelKind[]} */ (["marketplace", "store"]));
const KIND_LABELS = Object.freeze({ marketplace: "Marketplaces", store: "Lojas virtuais" });

/** @param {string | undefined} value */
const str = (value) => String(value || "").trim();
/** @param {string | undefined} value */
const list = (value) => str(value).split(",").map((item) => item.trim()).filter(Boolean);

/** @type {readonly ChannelDefinition[]} */
const CHANNEL_DEFINITIONS = Object.freeze([
  {
    id: "mercadolivre",
    label: "Mercado Livre",
    kind: "marketplace",
    auth: "oauth",
    capabilities: { listings: true, stockWrite: true, priceWrite: true, orders: true, fulfillment: true, labels: true },
    settingsFromEnv: (env) => ({ clientId: str(env.HUB_ML_APP_ID), clientSecret: str(env.HUB_ML_CLIENT_SECRET) }),
    create: (settings, fetchImpl) => new MercadoLivreConnector({ clientId: settings.clientId, clientSecret: settings.clientSecret, fetchImpl }),
  },
  {
    id: "magalu",
    label: "Magalu",
    kind: "marketplace",
    auth: "oauth",
    capabilities: { listings: true, stockWrite: true, priceWrite: true, orders: true, fulfillment: true, labels: true },
    settingsFromEnv: (env) => ({ clientId: str(env.HUB_MAGALU_CLIENT_ID), clientSecret: str(env.HUB_MAGALU_CLIENT_SECRET), scopes: list(env.HUB_MAGALU_SCOPES), webhookSecret: str(env.HUB_MAGALU_WEBHOOK_SECRET) }),
    create: (settings, fetchImpl) => new MagaluConnector({ clientId: settings.clientId, clientSecret: settings.clientSecret, scopes: settings.scopes, webhookSecret: settings.webhookSecret, fetchImpl }),
  },
  {
    id: "shopee",
    label: "Shopee",
    kind: "marketplace",
    auth: "oauth",
    capabilities: { listings: true, stockWrite: true, priceWrite: true, orders: true, fulfillment: false, labels: true },
    settingsFromEnv: (env) => ({ partnerId: str(env.HUB_SHOPEE_PARTNER_ID), partnerKey: str(env.HUB_SHOPEE_PARTNER_KEY), apiBase: str(env.HUB_SHOPEE_API_BASE) || "https://partner.shopeemobile.com" }),
    create: (settings, fetchImpl) => new ShopeeConnector({ partnerId: settings.partnerId, partnerKey: settings.partnerKey, apiBase: settings.apiBase, fetchImpl }),
  },
]);

/**
 * Configuração de cada canal lida do ambiente.
 * @param {Record<string, string | undefined>} env @param {readonly ChannelDefinition[]} [definitions]
 * @returns {Record<string, Record<string, any>>}
 */
function channelSettingsFromEnv(env, definitions = CHANNEL_DEFINITIONS) {
  return Object.fromEntries(definitions.map((def) => [def.id, def.settingsFromEnv(env)]));
}

/**
 * Confere uma definição (usado no registro e nos testes): id único em minúsculas, tipo e conexão válidos.
 * @param {any} def @returns {string[]}
 */
function validateDefinition(def) {
  const problems = [];
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(String(def?.id || ""))) problems.push("id deve ser minúsculo, sem espaços");
  if (!def?.label) problems.push("label ausente");
  if (!CHANNEL_KINDS.includes(def?.kind)) problems.push("kind deve ser marketplace ou store");
  if (!["oauth", "credentials"].includes(def?.auth)) problems.push("auth deve ser oauth ou credentials");
  if (def?.auth === "credentials" && !(Array.isArray(def.credentialFields) && def.credentialFields.length)) problems.push("credentials exige credentialFields");
  for (const key of ["listings", "stockWrite", "priceWrite", "orders", "fulfillment"]) {
    if (typeof def?.capabilities?.[key] !== "boolean") problems.push(`capabilities.${key} deve ser booleano`);
  }
  if (typeof def?.create !== "function" || typeof def?.settingsFromEnv !== "function") problems.push("create e settingsFromEnv são obrigatórios");
  return problems;
}

module.exports = { CHANNEL_DEFINITIONS, CHANNEL_KINDS, KIND_LABELS, channelSettingsFromEnv, validateDefinition };
