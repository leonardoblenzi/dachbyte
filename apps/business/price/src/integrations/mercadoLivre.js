"use strict";

const crypto = require("crypto");
const { config, baseUrl, publicPath } = require("../config");
const { fetchJson, formBody } = require("./http");
const { getConnection, tokenValues, upsertConnection } = require("./tokenStore");
const { withTenant } = require("../db");

function callbackUrl(req) {
  return `${baseUrl(req)}${publicPath("/api/integrations/meli/callback")}`;
}

function pkce() {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function buildAuthUrl(req, state, challenge) {
  if (!config.meli.clientId) {
    throw Object.assign(new Error("MELI_CLIENT_ID nao configurado."), { statusCode: 503 });
  }
  const url = new URL(`${config.meli.authBase}/authorization`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.meli.clientId);
  url.searchParams.set("redirect_uri", callbackUrl(req));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function exchangeCode(req, code, verifier) {
  return fetchJson(`${config.meli.apiBase}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({
      grant_type: "authorization_code",
      client_id: config.meli.clientId,
      client_secret: config.meli.clientSecret,
      code,
      redirect_uri: callbackUrl(req),
      code_verifier: verifier,
    }),
  });
}

async function refreshLocked(auth, connectionId) {
  return withTenant(auth.tenantId, auth.userId, async (client) => {
    const row = await getConnection(auth, "meli", connectionId, { forUpdate: true, client });
    if (!row) throw Object.assign(new Error("Mercado Livre nao conectado."), { statusCode: 404 });
    const { refreshToken } = tokenValues(row);
    if (!refreshToken) throw Object.assign(new Error("Refresh token Mercado Livre ausente."), { statusCode: 409 });

    const data = await fetchJson(`${config.meli.apiBase}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        grant_type: "refresh_token",
        client_id: config.meli.clientId,
        client_secret: config.meli.clientSecret,
        refresh_token: refreshToken,
      }),
    });

    return upsertConnection(client, auth.tenantId, "meli", {
      status: "active",
      displayName: row.display_name,
      externalAccountId: String(data.user_id || row.external_account_id),
      apiBaseUrl: config.meli.apiBase,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenExpiresAt: new Date(Date.now() + Number(data.expires_in || 21600) * 1000),
      metadata: { ...row.metadata, scope: data.scope },
      lastRefreshAt: new Date(),
    });
  });
}

async function validConnection(auth, connectionId = null) {
  let row = await getConnection(auth, "meli", connectionId);
  if (!row) {
    throw Object.assign(new Error("Mercado Livre nao conectado."), {
      statusCode: 409,
      code: "meli_not_connected",
    });
  }
  if (!row.token_expires_at || new Date(row.token_expires_at).getTime() < Date.now() + 3 * 60_000) {
    row = await refreshLocked(auth, row.id);
  }
  return row;
}

async function meliCall(auth, path, params = {}, connectionId = null, retried = false) {
  let row = await validConnection(auth, connectionId);
  const { accessToken } = tokenValues(row);
  const url = new URL(`${config.meli.apiBase}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });

  try {
    return await fetchJson(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (error) {
    if (!retried && error.upstreamStatus === 401) {
      row = await refreshLocked(auth, row.id);
      return meliCall(auth, path, params, row.id, true);
    }
    throw error;
  }
}

async function me(auth, connectionId) {
  return meliCall(auth, "/users/me", {}, connectionId);
}

async function orderFees(auth, orderId, connectionId) {
  const order = await meliCall(auth, `/orders/${encodeURIComponent(orderId)}`, {}, connectionId);

  const billingPromise = meliCall(
    auth,
    "/billing/integration/group/ML/order/details",
    { order_ids: orderId },
    connectionId,
  ).catch((error) => ({ unavailable: true, message: error.message }));

  const discountsPromise = meliCall(
    auth,
    `/orders/${encodeURIComponent(orderId)}/discounts`,
    {},
    connectionId,
  ).catch((error) => ({ unavailable: true, message: error.message }));

  const shipmentPromise = order?.shipping?.id
    ? meliCall(auth, `/shipments/${order.shipping.id}`, {}, connectionId)
        .catch((error) => ({ unavailable: true, message: error.message }))
    : Promise.resolve(null);

  const [billing, discounts, shipment] = await Promise.all([
    billingPromise,
    discountsPromise,
    shipmentPromise,
  ]);

  const saleFee = (order.order_items || []).reduce((sum, item) => sum + Number(item.sale_fee || 0), 0);
  const marketplaceFee = (order.payments || []).reduce(
    (sum, payment) => sum + Number(payment.marketplace_fee || 0),
    0,
  );
  const shippingSellerCost = Number(shipment?.seller?.cost || shipment?.seller_cost || 0);

  return {
    channel: "meli",
    orderId: String(orderId),
    summary: {
      saleFee,
      marketplaceFee,
      shippingSellerCost,
      totalKnownFees: saleFee + shippingSellerCost,
    },
    order,
    billing,
    discounts,
    shipment,
  };
}

async function searchOrders(auth, { from, to, status, offset = 0, limit = 50, connectionId } = {}) {
  const row = await validConnection(auth, connectionId);
  const params = {
    seller: row.external_account_id,
    offset,
    limit: Math.min(50, Number(limit) || 50),
  };
  if (from) params["order.date_created.from"] = new Date(`${from}T00:00:00-03:00`).toISOString();
  if (to) params["order.date_created.to"] = new Date(`${to}T23:59:59-03:00`).toISOString();
  if (status) params["order.status"] = status;
  return meliCall(auth, "/orders/search", params, row.id);
}

async function searchSellerListings(auth,{siteId="MLB",sellerId,nickname,offset=0,limit=50,connectionId}={}){
  if(!sellerId&&!nickname)throw Object.assign(new Error("Seller ID ou nickname do concorrente e obrigatorio."),{statusCode:400});
  return meliCall(auth,`/sites/${encodeURIComponent(siteId)}/search`,{seller_id:sellerId,nickname:sellerId?null:nickname,offset:Math.max(0,Number(offset)||0),limit:Math.min(50,Math.max(1,Number(limit)||50))},connectionId);
}

module.exports = {
  callbackUrl,
  pkce,
  buildAuthUrl,
  exchangeCode,
  refreshLocked,
  me,
  orderFees,
  searchOrders,
  searchSellerListings,
};
