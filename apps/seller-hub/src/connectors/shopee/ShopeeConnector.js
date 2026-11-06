// @ts-check
"use strict";

const { ChannelConnector } = require("../contract");
const { requestJson } = require("../../platform/http");
const { hmacSha256Hex } = require("../../platform/crypto");
const { mapItem } = require("./mapper");

/** Status percorridos na importação. */
const ITEM_STATUSES = ["NORMAL", "UNLIST"];
const PAGE_SIZE = 100;
const BASE_INFO_BATCH = 50;

const DEFAULT_API_BASE = "https://partner.shopeemobile.com";

/** Conector da Shopee com o app próprio do DACH Hub (categoria ERP System). */
class ShopeeConnector extends ChannelConnector {
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

  /**
   * Chamada de loja: assinatura HMAC(partner_id + path + timestamp + access_token + shop_id).
   * @param {{ accessToken: string, externalAccountId: string }} account @param {string} path @param {Record<string, string | number>} query
   */
  async shopGet(account, path, query) {
    const timestamp = this.now();
    const sign = hmacSha256Hex(this.partnerKey, `${this.partnerId}${path}${timestamp}${account.accessToken}${account.externalAccountId}`);
    const params = new URLSearchParams({
      partner_id: this.partnerId, timestamp: String(timestamp), access_token: account.accessToken,
      shop_id: String(account.externalAccountId), sign, ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
    });
    const payload = await requestJson(`${this.apiBase}${path}?${params}`, { fetchImpl: this.fetchImpl });
    if (payload?.error) throw Object.assign(new Error(payload.message || payload.error), { status: 502, code: payload.error, payload });
    return payload?.response || {};
  }

  /**
   * Uma página de itens (NORMAL → UNLIST), com detalhes em lotes de 50 e modelos por item.
   * @param {{ accessToken: string, externalAccountId: string }} account @param {{ cursor?: string | null }} [options]
   */
  async listListings(account, { cursor = null } = {}) {
    const parsed = cursor ? JSON.parse(cursor) : { s: 0, o: 0 };
    const status = ITEM_STATUSES[parsed.s];
    if (!status) return { listings: [], nextCursor: null };
    const page = await this.shopGet(account, "/api/v2/product/get_item_list", { offset: parsed.o, page_size: PAGE_SIZE, item_status: status });
    const ids = (Array.isArray(page.item) ? page.item : []).map((/** @type {any} */ row) => String(row.item_id));
    /** @type {any[]} */
    const listings = [];
    for (let i = 0; i < ids.length; i += BASE_INFO_BATCH) {
      const info = await this.shopGet(account, "/api/v2/product/get_item_base_info", { item_id_list: ids.slice(i, i + BASE_INFO_BATCH).join(",") });
      for (const item of Array.isArray(info.item_list) ? info.item_list : []) {
        const models = item.has_model ? (await this.shopGet(account, "/api/v2/product/get_model_list", { item_id: item.item_id })).model || [] : [];
        listings.push(...mapItem(item, models));
      }
    }
    const next = page.has_next_page ? { s: parsed.s, o: Number(page.next_offset) || parsed.o + PAGE_SIZE } : { s: parsed.s + 1, o: 0 };
    return { listings, nextCursor: ITEM_STATUSES[next.s] ? JSON.stringify(next) : null };
  }

  /** @param {{ refreshToken: string, externalAccountId?: string }} input */
  async refresh({ refreshToken, externalAccountId }) {
    const body = await this.authCall("/api/v2/auth/access_token/get", { refresh_token: refreshToken, shop_id: Number(externalAccountId) });
    return ShopeeConnector.tokenSet(body, refreshToken);
  }
}

module.exports = { ShopeeConnector, DEFAULT_API_BASE };
