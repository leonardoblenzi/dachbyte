"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createTrayConnectHandler, createTrayCallbackHandler } = require("../src/routes/integrations.routes");
const { createTrayClient } = require("../src/integrations/tray");

function request({ body = {}, query = {}, cookies = {} } = {}) {
  return {
    body,
    query,
    cookies,
    vpAuth: { tenantId: "tenant-1", userId: "user-1" },
    ip: "203.0.113.8",
    get: () => "tray-oauth-test",
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    cookies: [],
    cleared: [],
    redirectedTo: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    cookie(name, value, options) { this.cookies.push({ name, value, options }); return this; },
    clearCookie(name, options) { this.cleared.push({ name, options }); return this; },
    redirect(location) { this.redirectedTo = location; return this; },
  };
}

async function invoke(handler, req) {
  const res = response();
  let error;
  await handler(req, res, (nextError) => { error = nextError; });
  return { res, error };
}

test("Tray connect creates an opaque state cookie and returns only an authorization URL", async () => {
  const handler = createTrayConnectHandler({
    createOAuthState: async () => "opaque-state",
    buildAuthUrl: () => "https://loja.commercesuite.com.br/auth.php?callback=https%3A%2F%2Fapp.test%2Fcallback%3Fstate%3Dopaque-state",
  });

  const { res, error } = await invoke(handler, request({ body: { storeHost: "https://loja.commercesuite.com.br" } }));

  assert.equal(error, undefined);
  assert.deepEqual(res.body, { authorizationUrl: "https://loja.commercesuite.com.br/auth.php?callback=https%3A%2F%2Fapp.test%2Fcallback%3Fstate%3Dopaque-state" });
  assert.equal(res.cookies.length, 1);
  assert.deepEqual(res.cookies[0], {
    name: "vp_tray_oauth_state", value: "opaque-state",
    options: { httpOnly: true, secure: false, sameSite: "lax", path: "/volt-price/api/integrations/tray/callback", maxAge: 15 * 60_000 },
  });
  assert.doesNotMatch(JSON.stringify(res.body), /consumer|secret|access_token|refresh_token|code/i);
});

test("Tray callback persists exchanged tokens but redirects and audits only safe metadata", async () => {
  const audits = [];
  const stored = [];
  const handler = createTrayCallbackHandler({
    consumeOAuthState: async () => ({ tenant_id: "tenant-1", user_id: "user-1", payload: { storeHost: "https://loja.commercesuite.com.br" } }),
    exchangeCode: async () => ({
      access_token: "access-secret", refresh_token: "refresh-secret", api_host: "https://api.commercesuite.com.br",
      store_id: "42", date_expiration_access_token: "2026-08-13 12:00:00",
    }),
    withTenant: async (_tenantId, _userId, work) => work({}),
    upsertConnection: async (_client, _tenantId, channel, data) => stored.push({ channel, data }),
    audit: async (_client, event) => audits.push(event),
    parseTrayDate: (value) => value ? new Date("2026-08-13T15:00:00.000Z") : null,
  });

  const { res, error } = await invoke(handler, request({ query: { state: "opaque-state", code: "provider-code", api_address: "https://api.commercesuite.com.br" } }));

  assert.equal(error, undefined);
  assert.equal(res.redirectedTo, "/volt-price/app/integrations?connected=tray");
  assert.equal(res.body, null);
  assert.equal(res.cleared.length, 1);
  assert.equal(stored.length, 1);
  assert.deepEqual({ ...stored[0].data, lastRefreshAt: null }, {
    status: "active", displayName: "Tray 42", externalAccountId: "42", apiBaseUrl: "https://api.commercesuite.com.br",
    accessToken: "access-secret", refreshToken: "refresh-secret", tokenExpiresAt: new Date("2026-08-13T15:00:00.000Z"),
    refreshExpiresAt: null, metadata: { store_id: "42", store_host: "https://loja.commercesuite.com.br" }, lastRefreshAt: null,
  });
  assert.equal(stored[0].channel, "tray");
  assert.ok(stored[0].data.lastRefreshAt instanceof Date);
  assert.deepEqual(audits.map((event) => ({ action: event.action, metadata: event.metadata })), [{ action: "integration.connect", metadata: { store_id: "42" } }]);
  assert.doesNotMatch(JSON.stringify({ redirect: res.redirectedTo, audits }), /access-secret|refresh-secret|provider-code/i);
});

test("Tray callback redirects to a constant generic failure route without provider input", async () => {
  const diagnostics = [];
  const handler = createTrayCallbackHandler({ consumeOAuthState: async () => null, logFailure: (event) => diagnostics.push(event) });
  const { res, error } = await invoke(handler, request({ query: { state: "bad-secret", code: "provider-code", api_address: "https://evil.example" } }));

  assert.equal(error, undefined);
  assert.equal(res.redirectedTo, "/volt-price/app/integrations?tray=error");
  assert.doesNotMatch(res.redirectedTo, /bad-secret|provider-code|evil/i);
  assert.deepEqual(diagnostics, [{ stage: "state", code: null, statusCode: null, upstreamStatus: null }]);
});

test("Tray retries an order request once after a locked refresh", async () => {
  let current = { id: "connection-1", api_base_url: "https://api.commercesuite.com.br", display_name: "Tray 42", external_account_id: "42", metadata: {}, token_expires_at: new Date(Date.now() + 60 * 60_000), refresh_expires_at: null };
  let accessToken = "old-access";
  let refreshToken = "old-refresh";
  let orderAttempts = 0;
  let refreshAttempts = 0;

  const tray = createTrayClient({
    trayConfig: { consumerKey: "consumer-key", consumerSecret: "consumer-secret", allowedHosts: [".commercesuite.com.br"] },
    getConnectionFn: async () => current,
    tokenValuesFn: () => ({ accessToken, refreshToken }),
    withTenantFn: async (_tenantId, _userId, work) => work({}),
    upsertConnectionFn: async (_client, _tenantId, _channel, data) => {
      refreshAttempts += 1;
      accessToken = data.accessToken;
      refreshToken = data.refreshToken;
      current = { ...current, api_base_url: data.apiBaseUrl, token_expires_at: data.tokenExpiresAt, refresh_expires_at: data.refreshExpiresAt };
      return current;
    },
    fetchJsonFn: async (url) => {
      const href = String(url);
      if (href.includes("/auth?refresh_token=")) return { access_token: "new-access", refresh_token: "new-refresh", api_host: "https://api.commercesuite.com.br", date_expiration_access_token: "2030-08-13 12:00:00" };
      orderAttempts += 1;
      if (orderAttempts === 1) {
        const error = new Error("token expired");
        error.upstreamStatus = 401;
        throw error;
      }
      return { Orders: [] };
    },
  });

  const result = await tray.listOrders({ tenantId: "tenant-1", userId: "user-1" });

  assert.deepEqual(result, { Orders: [] });
  assert.equal(orderAttempts, 2);
  assert.equal(refreshAttempts, 1);
  assert.equal(accessToken, "new-access");
  assert.equal(refreshToken, "new-refresh");
});

test("Tray accepts a public custom-store URL without a configured host allowlist", () => {
  const tray = createTrayClient({
    trayConfig: { consumerKey: "consumer-key", consumerSecret: "consumer-secret" },
    baseUrlFn: () => "https://volt-staging.onrender.com",
  });

  const authorizationUrl = tray.buildAuthUrl({ headers: {}, get: () => "volt-staging.onrender.com" }, "https://www.drossiinteriores.com.br", "opaque-state");

  assert.match(authorizationUrl, /^https:\/\/www\.drossiinteriores\.com\.br\/auth\.php\?/);
});

test("Tray preserves the provider API path while exchanging the authorization code", async () => {
  let requestedUrl;
  const tray = createTrayClient({
    trayConfig: { consumerKey: "consumer-key", consumerSecret: "consumer-secret" },
    fetchJsonFn: async (url) => { requestedUrl = String(url); return { access_token: "access", refresh_token: "refresh" }; },
  });

  await tray.exchangeCode({ code: "provider-code", apiAddress: "https://www.drossiinteriores.com.br/web_api" });

  assert.equal(requestedUrl, "https://www.drossiinteriores.com.br/web_api/auth");
});
