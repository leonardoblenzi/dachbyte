// @ts-check
"use strict";

const { ChannelConnector } = require("../contract");
const { requestJson } = require("../../platform/http");
const { mapSku } = require("./mapper");

const AUTHORIZE_URL = "https://id.magalu.com/login";
const API_BASE = "https://api.magalu.com";
/** Status percorridos na importação; só PUBLISHED busca preço e estoque (padrão do DACH Magalu). */
const LIST_STATUSES = ["PUBLISHED", "UNPUBLISHED", "BLOCKED"];
const PAGE_SIZE = 100;
/** A API do portfólio limita a paginação a 20 mil por status. */
const MAX_OFFSET = 20_000;
const DETAIL_CONCURRENCY = 4;

/** @template T, R @param {T[]} items @param {number} limit @param {(item: T) => Promise<R>} fn @returns {Promise<R[]>} */
async function mapWithConcurrency(items, limit, fn) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  });
  await Promise.all(workers);
  return out;
}
const TOKEN_URL = "https://id.magalu.com/oauth/token";

/** Escopos de leitura de catálogo e pedidos + escrita de estoque e preço (mesmos nomes do ID Magalu usados no DACH Magalu). */
const DEFAULT_SCOPES = [
  "open:portfolio-skus-seller:read",
  "open:portfolio-prices-seller:read",
  "open:portfolio-stocks-seller:read",
  "open:order-order-seller:read",
  "open:order-delivery-seller:read",
  "open:portfolio-stocks-seller:write",
  "open:portfolio-prices-seller:write",
  // Etiquetas do Magalu Entregas (Fase 3 / P4). Contas conectadas antes precisam reconectar para ganhar o escopo.
  "open:order-logistics-seller:read",
  "open:order-logistics-seller:write",
];

/** Lê o payload de um JWT sem validar assinatura (só para identificar o tenant). @param {string} token */
function jwtPayload(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return {};
  try { return JSON.parse(Buffer.from(part, "base64url").toString("utf8")); } catch (_error) { return {}; }
}

/** Conector do Magalu com o client próprio do DACH Hub no ID Magalu. */
class MagaluConnector extends ChannelConnector {
  /** @param {{ clientId: string, clientSecret: string, scopes?: string[], fetchImpl?: typeof fetch, now?: () => number }} options */
  constructor({ clientId, clientSecret, scopes = DEFAULT_SCOPES, fetchImpl = fetch, now = () => Date.now() }) {
    super();
    this.clientId = String(clientId || "");
    this.clientSecret = String(clientSecret || "");
    this.scopes = scopes.length ? scopes : DEFAULT_SCOPES;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  get channel() { return "magalu"; }
  get configured() { return Boolean(this.clientId && this.clientSecret); }

  /** @param {{ state: string, redirectUri: string }} input */
  authorizeUrl({ state, redirectUri }) {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", this.scopes.join(" "));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("choose_tenants", "true");
    url.searchParams.set("state", state);
    return url.toString();
  }

  /** @param {any} body @param {string | null} [fallbackRefresh] */
  static tokenSet(body, fallbackRefresh = null) {
    if (!body?.access_token) throw Object.assign(new Error("O ID Magalu não devolveu o token de acesso."), { status: 502 });
    const claims = jwtPayload(body.access_token);
    const expSeconds = Number(body.expires_in) > 0 ? Date.now() + Number(body.expires_in) * 1000 : Number(claims.exp) > 0 ? Number(claims.exp) * 1000 : null;
    return {
      accessToken: String(body.access_token),
      refreshToken: body.refresh_token ? String(body.refresh_token) : fallbackRefresh,
      expiresAt: expSeconds ? new Date(expSeconds) : null,
      scopes: String(body.scope || "").split(/\s+/).filter(Boolean),
    };
  }

  /** @param {{ code: string, redirectUri: string }} input */
  async exchangeCode({ code, redirectUri }) {
    const body = await requestJson(TOKEN_URL, {
      method: "POST", headers: { "content-type": "application/json" }, fetchImpl: this.fetchImpl,
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, redirect_uri: redirectUri, code, grant_type: "authorization_code" }),
    });
    const tokens = MagaluConnector.tokenSet(body);
    return { tokens, account: MagaluConnector.identity(tokens.accessToken) };
  }

  /** @param {{ refreshToken: string }} input */
  async refresh({ refreshToken }) {
    const form = new URLSearchParams({ grant_type: "refresh_token", client_id: this.clientId, client_secret: this.clientSecret, refresh_token: refreshToken });
    const body = await requestJson(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString(), fetchImpl: this.fetchImpl });
    return MagaluConnector.tokenSet(body, refreshToken);
  }

  /** @param {string} accessToken @param {string} path */
  async get(accessToken, path) {
    return requestJson(`${API_BASE}${path}`, { headers: { authorization: `Bearer ${accessToken}` }, fetchImpl: this.fetchImpl });
  }

  /**
   * Uma página do portfólio. Cursor = status + offset (PUBLISHED → UNPUBLISHED → BLOCKED).
   * @param {{ accessToken: string }} account @param {{ cursor?: string | null }} [options]
   */
  async listListings(account, { cursor = null } = {}) {
    const parsed = cursor ? JSON.parse(cursor) : { s: 0, o: 0 };
    const status = LIST_STATUSES[parsed.s];
    if (!status) return { listings: [], nextCursor: null };
    const params = new URLSearchParams({ _offset: String(parsed.o), _limit: String(PAGE_SIZE), status, sort: "updated_at:desc" });
    const page = await this.get(account.accessToken, `/seller/v1/portfolios/skus?${params}`);
    const rows = Array.isArray(page?.results) ? page.results : [];
    const listings = (await mapWithConcurrency(rows, DETAIL_CONCURRENCY, async (sku) => {
      const code = String(sku?.sku || "").trim();
      if (!code || status !== "PUBLISHED") return mapSku({ sku });
      const path = encodeURIComponent(code);
      const [price, stock] = await Promise.all([
        this.get(account.accessToken, `/seller/v1/portfolios/prices/${path}`).catch(() => null),
        this.get(account.accessToken, `/seller/v1/portfolios/stocks/${path}`).catch(() => null),
      ]);
      return mapSku({ sku, price, stock });
    })).filter(Boolean);
    const nextOffset = parsed.o + PAGE_SIZE;
    const statusDone = rows.length < PAGE_SIZE || nextOffset >= MAX_OFFSET;
    const next = statusDone ? { s: parsed.s + 1, o: 0 } : { s: parsed.s, o: nextOffset };
    return { listings: /** @type {any[]} */ (listings), nextCursor: LIST_STATUSES[next.s] ? JSON.stringify(next) : null };
  }

  /** O tenant do seller vem no claim `sub` do access token. @param {string} accessToken */
  static identity(accessToken) {
    const claims = jwtPayload(accessToken);
    const subject = String(claims.sub || "").trim();
    if (!subject) throw Object.assign(new Error("O token do Magalu não informou a organização (sub)."), { status: 502 });
    const label = claims.tenant_name || claims.name || claims.preferred_username || null;
    return { externalAccountId: subject, label: label ? String(label) : null };
  }
}

// Pedidos, notificações e escrita de estoque (E3).
Object.assign(MagaluConnector.prototype, require("./orders").magaluOrders, require("../labels").magaluLabels);

module.exports = { MagaluConnector, DEFAULT_SCOPES, _test: { jwtPayload, mapWithConcurrency } };
