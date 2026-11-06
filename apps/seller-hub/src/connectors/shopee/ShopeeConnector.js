// @ts-check
"use strict";

const { MarketplaceConnector } = require("../contract");
const { requestJson } = require("../../platform/http");
const { hmacSha256Hex } = require("../../platform/crypto");

const DEFAULT_API_BASE = "https://partner.shopeemobile.com";

/** Conector da Shopee com o app próprio do DACH Hub (categoria ERP System). */
class ShopeeConnector extends MarketplaceConnector {
  /** @param {{ partnerId: string, partnerKey: string, apiBase?: string, fetchImpl?: typeof fetch, now?: () => number }} options */
  constructor({ partnerId, partnerKey, apiBase = DEFAULT_API_BASE, fetchImpl = fetch, now = () => Math.floor(Date.now() / 1000) }) {
    super();
    this.partnerId = String(partnerId || "");
    this.partnerKey = String(partnerKey || "");
    this.apiBase = String(apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  get channel() { return "shopee"; }
  get configured() { return Boolean(this.partnerId && this.partnerKey); }

  /** Assinatura das chamadas de autorização: HMAC(partner_id + path + timestamp). @param {string} path @param {number} timestamp */
  authSign(path, timestamp) {
    return hmacSha256Hex(this.partnerKey, `${this.partnerId}${path}${timestamp}`);
  }

  /**
   * A Shopee devolve `code` e `shop_id` no redirect; o `state` vai dentro da própria URL de retorno.
   * @param {{ state: string, redirectUri: string }} input
   */
  authorizeUrl({ state, redirectUri }) {
    const path = "/api/v2/shop/auth_partner";
    const timestamp = this.now();
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("state", state);
    const url = new URL(`${this.apiBase}${path}`);
    url.searchParams.set("partner_id", this.partnerId);
    url.searchParams.set("timestamp", String(timestamp));
    url.searchParams.set("sign", this.authSign(path, timestamp));
    url.searchParams.set("redirect", redirect.toString());
    return url.toString();
  }

  /** @param {string} path @param {Record<string, any>} body */
  async authCall(path, body) {
    const timestamp = this.now();
    const url = `${this.apiBase}${path}?partner_id=${encodeURIComponent(this.partnerId)}&timestamp=${timestamp}&sign=${this.authSign(path, timestamp)}`;
    const payload = await requestJson(url, {
      method: "POST", headers: { "content-type": "application/json" }, fetchImpl: this.fetchImpl,
      body: JSON.stringify({ ...body, partner_id: Number(this.partnerId) }),
    });
    if (payload?.error) throw Object.assign(new Error(payload.message || payload.error), { status: 502, code: payload.error, payload });
    return payload?.data && typeof payload.data === "object" ? payload.data : payload;
  }

  /** @param {any} body @param {string | null} [fallbackRefresh] */
  static tokenSet(body, fallbackRefresh = null) {
    if (!body?.access_token) throw Object.assign(new Error("A Shopee não devolveu o token de acesso."), { status: 502 });
    return {
      accessToken: String(body.access_token),
      refreshToken: body.refresh_token ? String(body.refresh_token) : fallbackRefresh,
      expiresAt: Number(body.expire_in) > 0 ? new Date(Date.now() + Number(body.expire_in) * 1000) : null,
      scopes: [],
    };
  }

  /** @param {{ code: string, shopId?: string | number }} input */
  async exchangeCode({ code, shopId }) {
    const sid = Number(shopId);
    if (!Number.isInteger(sid) || sid <= 0) throw Object.assign(new Error("A Shopee não informou a loja (shop_id)."), { status: 400 });
    const tokens = ShopeeConnector.tokenSet(await this.authCall("/api/v2/auth/token/get", { code, shop_id: sid }));
    return { tokens, account: { externalAccountId: String(sid), label: `Loja Shopee ${sid}` } };
  }

  /** @param {{ refreshToken: string, externalAccountId?: string }} input */
  async refresh({ refreshToken, externalAccountId }) {
    const body = await this.authCall("/api/v2/auth/access_token/get", { refresh_token: refreshToken, shop_id: Number(externalAccountId) });
    return ShopeeConnector.tokenSet(body, refreshToken);
  }
}

module.exports = { ShopeeConnector, DEFAULT_API_BASE };
