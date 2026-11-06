// @ts-check
"use strict";

const { MarketplaceConnector } = require("../contract");
const { requestJson } = require("../../platform/http");

const AUTHORIZE_URL = "https://id.magalu.com/login";
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
];

/** Lê o payload de um JWT sem validar assinatura (só para identificar o tenant). @param {string} token */
function jwtPayload(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return {};
  try { return JSON.parse(Buffer.from(part, "base64url").toString("utf8")); } catch (_error) { return {}; }
}

/** Conector do Magalu com o client próprio do DACH Hub no ID Magalu. */
class MagaluConnector extends MarketplaceConnector {
  /** @param {{ clientId: string, clientSecret: string, scopes?: string[], fetchImpl?: typeof fetch }} options */
  constructor({ clientId, clientSecret, scopes = DEFAULT_SCOPES, fetchImpl = fetch }) {
    super();
    this.clientId = String(clientId || "");
    this.clientSecret = String(clientSecret || "");
    this.scopes = scopes.length ? scopes : DEFAULT_SCOPES;
    this.fetchImpl = fetchImpl;
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

  /** O tenant do seller vem no claim `sub` do access token. @param {string} accessToken */
  static identity(accessToken) {
    const claims = jwtPayload(accessToken);
    const subject = String(claims.sub || "").trim();
    if (!subject) throw Object.assign(new Error("O token do Magalu não informou a organização (sub)."), { status: 502 });
    const label = claims.tenant_name || claims.name || claims.preferred_username || null;
    return { externalAccountId: subject, label: label ? String(label) : null };
  }
}

module.exports = { MagaluConnector, DEFAULT_SCOPES, _test: { jwtPayload } };
