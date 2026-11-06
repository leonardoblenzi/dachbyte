// @ts-check
"use strict";

const { ChannelConnector } = require("../contract");
const { requestJson } = require("../../platform/http");
const { mapItemsBatch } = require("./mapper");

const AUTH_URL = "https://auth.mercadolivre.com.br/authorization";
const API = "https://api.mercadolibre.com";

/**
 * @typedef {{ accessToken: string, refreshToken: string | null, expiresAt: Date | null, scopes: string[] }} TokenSet
 * @typedef {{ externalAccountId: string, label: string | null }} AccountIdentity
 */

/** Conector do Mercado Livre com o app próprio do DACH Hub. */
class MercadoLivreConnector extends ChannelConnector {
  /** @param {{ clientId: string, clientSecret: string, fetchImpl?: typeof fetch }} options */
  constructor({ clientId, clientSecret, fetchImpl = fetch }) {
    super();
    this.clientId = String(clientId || "");
    this.clientSecret = String(clientSecret || "");
    this.fetchImpl = fetchImpl;
  }

  get channel() { return "mercadolivre"; }
  get configured() { return Boolean(this.clientId && this.clientSecret); }

  /** @param {{ state: string, redirectUri: string }} input */
  authorizeUrl({ state, redirectUri }) {
    const url = new URL(AUTH_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  }

  /** @param {any} body @returns {TokenSet} */
  static tokenSet(body) {
    if (!body?.access_token) throw Object.assign(new Error("O Mercado Livre não devolveu o token de acesso."), { status: 502 });
    return {
      accessToken: String(body.access_token),
      refreshToken: body.refresh_token ? String(body.refresh_token) : null,
      expiresAt: Number(body.expires_in) > 0 ? new Date(Date.now() + Number(body.expires_in) * 1000) : null,
      scopes: String(body.scope || "").split(/\s+/).filter(Boolean),
    };
  }

  /** @param {Record<string, string>} fields */
  async tokenRequest(fields) {
    const body = new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...fields });
    return requestJson(`${API}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(), fetchImpl: this.fetchImpl,
    });
  }

  /** @param {{ code: string, redirectUri: string }} input */
  async exchangeCode({ code, redirectUri }) {
    const tokens = MercadoLivreConnector.tokenSet(await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri }));
    return { tokens, account: await this.whoAmI(tokens.accessToken) };
  }

  /** O refresh do ML é de uso único: quem chama precisa da trava por conta. @param {{ refreshToken: string }} input */
  async refresh({ refreshToken }) {
    return MercadoLivreConnector.tokenSet(await this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }));
  }

  /** @param {string} accessToken @returns {Promise<AccountIdentity>} */
  async whoAmI(accessToken) {
    const me = await requestJson(`${API}/users/me`, { headers: { authorization: `Bearer ${accessToken}` }, fetchImpl: this.fetchImpl });
    return { externalAccountId: String(me.id), label: me.nickname ? String(me.nickname) : null };
  }

  /**
   * Uma página de anúncios (scan por scroll_id + detalhes em lotes de 20).
   * @param {{ externalAccountId: string, accessToken: string }} account
   * @param {{ cursor?: string | null }} [options]
   */
  async listListings(account, { cursor = null } = {}) {
    const auth = { authorization: `Bearer ${account.accessToken}` };
    const search = new URL(`${API}/users/${encodeURIComponent(account.externalAccountId)}/items/search`);
    search.searchParams.set("search_type", "scan");
    search.searchParams.set("limit", "100");
    if (cursor) search.searchParams.set("scroll_id", cursor);
    const page = await requestJson(search.toString(), { headers: auth, fetchImpl: this.fetchImpl });
    const ids = Array.isArray(page.results) ? page.results.map(String) : [];
    const listings = [];
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      const body = await requestJson(`${API}/items?ids=${batch.map(encodeURIComponent).join(",")}&include_attributes=all`, { headers: auth, fetchImpl: this.fetchImpl });
      listings.push(...mapItemsBatch(body));
    }
    return { listings, nextCursor: ids.length ? String(page.scroll_id || "") || null : null };
  }
}

// Pedidos, notificações e escrita de estoque (E3).
Object.assign(MercadoLivreConnector.prototype, require("./orders").mercadoLivreOrders);

module.exports = { MercadoLivreConnector };
