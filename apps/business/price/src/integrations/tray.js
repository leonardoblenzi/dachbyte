"use strict";

const { config, baseUrl, publicPath } = require("../config");
const { fetchJson, formBody } = require("./http");
const { getConnection, tokenValues, upsertConnection } = require("./tokenStore");
const { withTenant } = require("../db");
const { assertSafeHttpsUrl } = require("../security");

function parseTrayDate(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(" ", "T") + (/Z|[+-]\d\d:?\d\d$/.test(String(value)) ? "" : "-03:00"));
  return Number.isNaN(date.getTime()) ? null : date;
}

function createTrayClient({
  trayConfig = config.tray,
  getConnectionFn = getConnection,
  tokenValuesFn = tokenValues,
  upsertConnectionFn = upsertConnection,
  withTenantFn = withTenant,
  fetchJsonFn = fetchJson,
  baseUrlFn = baseUrl,
} = {}) {
  function trayUrl(value) {
    return assertSafeHttpsUrl(value);
  }

  function normalizeStoreHost(value) {
    return trayUrl(value).origin;
  }

  function normalizeApiBase(value) {
    const url = trayUrl(value);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path === "/" ? "" : path}`;
  }

  function callbackUrl(req, state = "") {
    const url = new URL(`${baseUrlFn(req)}${publicPath("/api/integrations/tray/callback")}`);
    if (state) url.searchParams.set("state", state);
    return url.toString();
  }

  function buildAuthUrl(req, storeHost, state = "") {
    if (!trayConfig.consumerKey) throw Object.assign(new Error("TRAY_CONSUMER_KEY nao configurada."), { statusCode: 503 });
    const url = new URL(`${normalizeStoreHost(storeHost)}/auth.php`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("consumer_key", trayConfig.consumerKey);
    url.searchParams.set("callback", callbackUrl(req, state));
    return url.toString();
  }

  async function exchangeCode({ code, apiAddress }) {
    const apiBaseUrl = normalizeApiBase(apiAddress);
    if (!trayConfig.consumerKey || !trayConfig.consumerSecret) {
      throw Object.assign(new Error("Credenciais Tray nao configuradas."), { statusCode: 503 });
    }
    return fetchJsonFn(`${apiBaseUrl}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({ consumer_key: trayConfig.consumerKey, consumer_secret: trayConfig.consumerSecret, code }),
    });
  }

  async function refreshLocked(auth, connectionId) {
    return withTenantFn(auth.tenantId, auth.userId, async (client) => {
      const row = await getConnectionFn(auth, "tray", connectionId, { forUpdate: true, client });
      if (!row) throw Object.assign(new Error("Tray nao conectado."), { statusCode: 404 });
      const { refreshToken } = tokenValuesFn(row);
      if (!refreshToken) throw Object.assign(new Error("Refresh token Tray ausente."), { statusCode: 409 });
      const apiBaseUrl = normalizeApiBase(row.api_base_url);
      const data = await fetchJsonFn(`${apiBaseUrl}/auth?refresh_token=${encodeURIComponent(refreshToken)}`);
      return upsertConnectionFn(client, auth.tenantId, "tray", {
        status: "active",
        displayName: row.display_name,
        externalAccountId: row.external_account_id,
        apiBaseUrl: normalizeApiBase(data.api_host || apiBaseUrl),
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        tokenExpiresAt: parseTrayDate(data.date_expiration_access_token),
        refreshExpiresAt: parseTrayDate(data.date_expiration_refresh_token),
        metadata: { ...row.metadata, store_id: data.store_id || row.external_account_id },
        lastRefreshAt: new Date(),
      });
    });
  }

  async function validConnection(auth, connectionId = null) {
    let row = await getConnectionFn(auth, "tray", connectionId);
    if (!row) throw Object.assign(new Error("Tray nao conectado."), { statusCode: 409, code: "tray_not_connected" });
    if (!row.token_expires_at || new Date(row.token_expires_at).getTime() < Date.now() + 5 * 60_000) {
      row = await refreshLocked(auth, row.id);
    }
    return row;
  }

  async function trayCall(auth, pathname, params = {}, connectionId = null, retried = false) {
    const row = await validConnection(auth, connectionId);
    const { accessToken } = tokenValuesFn(row);
    const apiBaseUrl = normalizeApiBase(row.api_base_url);
    const url = new URL(`${apiBaseUrl}${pathname}`);
    url.searchParams.set("access_token", accessToken);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    });
    try {
      return await fetchJsonFn(url);
    } catch (error) {
      if (!retried && (error.upstreamStatus === 401 || /token/i.test(String(error.message)))) {
        const refreshed = await refreshLocked(auth, row.id);
        return trayCall(auth, pathname, params, refreshed.id, true);
      }
      throw error;
    }
  }

  async function listOrders(auth, { status, from, to, page = 1, limit = 50, connectionId } = {}) {
    const params = { page, limit: Math.min(50, Math.max(1, Number(limit) || 50)), sort: "date_asc" };
    if (status) params.status = status;
    if (from || to) {
      const start = from || "2000-01-01";
      const end = to || new Date().toISOString().slice(0, 10);
      params.date = `${start},${end} 23:59:59`;
    }
    return trayCall(auth, "/orders", params, connectionId);
  }

  function getOrder(auth, id, connectionId) {
    return trayCall(auth, `/orders/${encodeURIComponent(id)}`, {}, connectionId);
  }

  function getOrderComplete(auth, id, connectionId) {
    return trayCall(auth, `/orders/${encodeURIComponent(id)}/complete`, {}, connectionId);
  }

  return { buildAuthUrl, callbackUrl, exchangeCode, refreshLocked, listOrders, getOrder, getOrderComplete };
}

const defaultTrayClient = createTrayClient();

module.exports = { ...defaultTrayClient, createTrayClient, parseTrayDate };
