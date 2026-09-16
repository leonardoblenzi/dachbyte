"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createShopeeConnectHandler,
  createShopeeCallbackHandler,
} = require("../src/routes/integrations.routes");
const { createShopeeClient, normalizeTokenResponse } = require("../src/integrations/shopee");

test("aceita resposta de token Shopee encapsulada em response", () => {
  assert.deepEqual(normalizeTokenResponse({ response: { access_token: "access", refresh_token: "refresh", expire_in: 3600, refresh_token_expire_in: 7200 } }), {
    accessToken: "access", refreshToken: "refresh", expiresIn: 3600, refreshExpiresIn: 7200,
  });
});


const CALLBACK_PATH = "/business/price/api/integrations/shopee/callback";

function request({ query = {}, cookies = {}, vpAuth = { tenantId: "tenant-1", userId: "user-1" } } = {}) {
  return { query, cookies, vpAuth, headers: {}, get: () => "app.test" };
}

function response() {
  return {
    body: null, cookies: [], cleared: [], redirectedTo: null,
    json(value) { this.body = value; return this; },
    cookie(name, value, options) { this.cookies.push({ name, value, options }); return this; },
    clearCookie(name, options) { this.cleared.push({ name, options }); return this; },
    redirect(value) { this.redirectedTo = value; return this; },
  };
}

async function invoke(handler, req) {
  const res = response();
  let error;
  await handler(req, res, (nextError) => { error = nextError; });
  return { res, error };
}

test("Shopee connect creates a state for a new connection and sends the same opaque value to provider and callback cookie", async () => {
  let stateInput;
  let authInput;
  const handler = createShopeeConnectHandler({
    createOAuthState: async (...args) => { stateInput = args; return "opaque-state"; },
    buildAuthUrl: (...args) => { authInput = args; return "https://partner.test/auth?state=opaque-state"; },
  });

  const { res, error } = await invoke(handler, request());

  assert.equal(error, undefined);
  assert.deepEqual(stateInput, [{ tenantId: "tenant-1", userId: "user-1" }, "shopee", { intendedConnection: "new" }]);
  assert.deepEqual(authInput.slice(1), ["opaque-state"]);
  assert.deepEqual(res.body, { authorizationUrl: "https://partner.test/auth?state=opaque-state" });
  assert.deepEqual(res.cookies, [{ name: "vp_shopee_oauth_state", value: "opaque-state", options: {
    httpOnly: true, secure: false, sameSite: "lax", path: CALLBACK_PATH, maxAge: 15 * 60_000,
  } }]);
  assert.doesNotMatch(JSON.stringify(res.body), /access_token|refresh_token|code|partner.?key/i);
});

test("Shopee callback checks the provider state against the callback-only cookie before consuming it", async () => {
  let consumeCount = 0;
  let exchangeCount = 0;
  const handler = createShopeeCallbackHandler({
    consumeOAuthState: async () => { consumeCount += 1; return null; },
    exchangeCode: async () => { exchangeCount += 1; },
  });

  const { res, error } = await invoke(handler, request({
    query: { state: "provider-state", code: "provider-code", shop_id: "42" },
    cookies: { vp_shopee_oauth_state: "other-state" },
  }));

  assert.equal(error, undefined);
  assert.equal(consumeCount, 0);
  assert.equal(exchangeCount, 0);
  assert.equal(res.redirectedTo, "/business/price/app/integrations?shopee=error");
  assert.deepEqual(res.cleared, [{ name: "vp_shopee_oauth_state", options: { path: CALLBACK_PATH } }]);
  assert.doesNotMatch(res.redirectedTo, /provider-state|provider-code|other-state/i);
});

test("Shopee callback consumes state once, persists one connection per numeric shop id, and audits only safe data", async () => {
  const stored = [];
  const audits = [];
  let consumes = 0;
  const handler = createShopeeCallbackHandler({
    consumeOAuthState: async (state, channel) => {
      assert.equal(state, "opaque-state"); assert.equal(channel, "shopee");
      consumes += 1;
      return consumes === 1 ? { tenant_id: "tenant-1", user_id: "user-1", payload: {} } : null;
    },
    exchangeCode: async (code, shopId) => {
      assert.equal(code, "provider-code"); assert.equal(shopId, "42");
      return { access_token: "access-secret", refresh_token: "refresh-secret", expire_in: 3600, refresh_token_expire_in: 7200 };
    },
    withTenant: async (_tenantId, _userId, work) => work({}),
    getConnectionByExternalAccount: async () => null,
    upsertConnection: async (_client, tenantId, channel, data) => stored.push({ tenantId, channel, data }),
    audit: async (_client, event) => audits.push(event),
    shopeeConfig: { apiBase: "https://partner.test", partnerId: "123" },
  });
  const input = request({ query: { state: "opaque-state", code: "provider-code", shop_id: "42" }, cookies: { vp_shopee_oauth_state: "opaque-state" } });

  const first = await invoke(handler, input);
  const second = await invoke(handler, input);

  assert.equal(first.res.redirectedTo, "/business/price/app/integrations?connected=shopee");
  assert.equal(second.res.redirectedTo, "/business/price/app/integrations?shopee=error");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].channel, "shopee");
  assert.equal(stored[0].data.externalAccountId, "42");
  assert.deepEqual(stored[0].data.metadata, { partner_id: "123", shop_id: "42" });
  assert.deepEqual(audits.map(({ action, resourceId, metadata }) => ({ action, resourceId, metadata })), [{
    action: "integration.connect", resourceId: "shopee:42", metadata: { shop_id: "42", authorization_link: false },
  }]);
  assert.doesNotMatch(JSON.stringify({ redirect: first.res.redirectedTo, audits }), /access-secret|refresh-secret|provider-code|opaque-state/i);
});

for (const query of [
  { state: "opaque-state", shop_id: "42" },
  { state: "opaque-state", code: "provider-code" },
  { state: "opaque-state", code: "provider-code", shop_id: "not-a-shop" },
]) {
  test(`Shopee callback rejects incomplete or invalid callback (${JSON.stringify(query)}) without exchanging`, async () => {
    let exchanges = 0;
    const handler = createShopeeCallbackHandler({
      consumeOAuthState: async () => ({ tenant_id: "tenant-1", user_id: "user-1" }),
      exchangeCode: async () => { exchanges += 1; },
    });
    const { res } = await invoke(handler, request({ query, cookies: { vp_shopee_oauth_state: "opaque-state" } }));
    assert.equal(exchanges, 0);
    assert.equal(res.redirectedTo, "/business/price/app/integrations?shopee=error");
  });
}

test("Shopee client adds state and canonical callback to the signed authorization request", () => {
  const client = createShopeeClient({
    shopeeConfig: { partnerId: "123", partnerKey: "partner-key", apiBase: "https://partner.test", authPartnerPath: "/api/v2/shop/auth_partner" },
    baseUrlFn: () => "https://canonical.example",
    clock: () => 1_700_000_000_000,
  });
  const url = new URL(client.buildAuthUrl(request(), "opaque-state"));
  assert.equal(url.searchParams.get("state"), "opaque-state");
  assert.equal(url.searchParams.get("redirect"), "https://canonical.example/business/price/api/integrations/shopee/callback");
  assert.equal(url.searchParams.get("sign"), "8be68f44082a64f7f2692d9b8b634e6a9ca47b28306a130b4e41a516ff7e138f");
});

test("Shopee retries a token failure once after a locked, rotating refresh for the selected connection", async () => {
  let connection = { id: "shop-a", status: "active", external_account_id: "42", display_name: "Shopee 42", metadata: {}, token_expires_at: new Date("2030-01-01") };
  let accessToken = "old-access";
  let refreshToken = "old-refresh";
  let calls = 0;
  let locks = 0;
  const client = createShopeeClient({
    shopeeConfig: { partnerId: "123", partnerKey: "partner-key", apiBase: "https://partner.test", refreshPath: "/refresh", escrowPath: "/escrow" },
    clock: () => 1_700_000_000_000,
    getConnectionFn: async (_auth, _channel, id, options = {}) => { if (options.forUpdate) locks += 1; assert.equal(id, "shop-a"); return connection; },
    tokenValuesFn: () => ({ accessToken, refreshToken }),
    withTenantFn: async (_tenant, _user, work) => work({}),
    upsertConnectionFn: async (_db, _tenant, _channel, value) => { accessToken = value.accessToken; refreshToken = value.refreshToken; connection = { ...connection, id: "shop-a", token_expires_at: value.tokenExpiresAt }; return connection; },
    fetchJsonFn: async (url) => {
      if (String(url).includes("/refresh")) return { access_token: "new-access", refresh_token: "new-refresh", expire_in: 3600 };
      calls += 1;
      return calls === 1 ? { error: "error_auth", message: "access token expired" } : { response: { order_income: {} } };
    },
  });

  await client.orderFees({ tenantId: "tenant-1", userId: "user-1" }, "ORDER-1", "shop-a");

  assert.equal(calls, 2);
  assert.equal(locks, 1);
  assert.equal(accessToken, "new-access");
  assert.equal(refreshToken, "new-refresh");
});



test("Shopee turns a revoked refresh token into a safe reauthorization state for that connection", async () => {
  let marked;
  const client = createShopeeClient({
    shopeeConfig: { partnerId: "123", partnerKey: "partner-key", apiBase: "https://partner.test", refreshPath: "/refresh" },
    getConnectionFn: async (_auth, _channel, id) => ({ id, external_account_id: "42", metadata: {} }),
    tokenValuesFn: () => ({ accessToken: "access", refreshToken: "rotating-refresh" }),
    withTenantFn: async (_tenant, _user, work) => work({}),
    markConnectionErrorFn: async (_auth, id, value) => { marked = { id, value }; },
    fetchJsonFn: async () => ({ error: "error_auth" }),
  });

  await assert.rejects(
    () => client.refreshLocked({ tenantId: "tenant-1", userId: "user-1" }, "shop-a"),
    (error) => error.code === "reauthorization_required" && error.statusCode === 409,
  );
  assert.deepEqual(marked, { id: "shop-a", value: "reauthorization_required" });
});
test("Shopee concurrent refreshes reuse the connection refreshed while the second call waited for its row lock", async () => {
  const fixedNow = 1_700_000_000_000;
  let connection = { id: "shop-a", status: "active", external_account_id: "42", display_name: "Shopee 42", metadata: {}, token_expires_at: new Date(fixedNow + 60_000) };
  let locked = false;
  const waiters = [];
  let refreshCalls = 0;
  let firstRefreshStarted;
  const firstRefreshStartedPromise = new Promise((resolve) => { firstRefreshStarted = resolve; });
  let releaseFirstRefresh;
  const client = createShopeeClient({
    shopeeConfig: { partnerId: "123", partnerKey: "partner-key", apiBase: "https://partner.test", refreshPath: "/refresh" },
    clock: () => fixedNow,
    getConnectionFn: async () => connection,
    tokenValuesFn: () => ({ accessToken: "access", refreshToken: "old-rotating-refresh" }),
    withTenantFn: async (_tenant, _user, work) => {
      while (locked) await new Promise((resolve) => waiters.push(resolve));
      locked = true;
      try { return await work({}); } finally { locked = false; waiters.shift()?.(); }
    },
    upsertConnectionFn: async (_db, _tenant, _channel, data) => {
      connection = { ...connection, token_expires_at: data.tokenExpiresAt };
      return connection;
    },
    fetchJsonFn: async () => {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        firstRefreshStarted();
        return new Promise((resolve) => { releaseFirstRefresh = () => resolve({ access_token: "new-access", refresh_token: "new-rotating-refresh", expire_in: 3600 }); });
      }
      return { access_token: "unexpected-access", refresh_token: "unexpected-refresh", expire_in: 3600 };
    },
  });
  const auth = { tenantId: "tenant-1", userId: "user-1" };
  const first = client.refreshLocked(auth, "shop-a");
  await firstRefreshStartedPromise;
  const second = client.refreshLocked(auth, "shop-a");
  await Promise.resolve();
  releaseFirstRefresh();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(refreshCalls, 1);
  assert.equal(firstResult.token_expires_at.getTime(), fixedNow + 3_600_000);
  assert.equal(secondResult.token_expires_at.getTime(), fixedNow + 3_600_000);
});
test("Shopee concurrent refreshes reuse a token renewed from a null expiration", async () => {
  const fixedNow = 1_700_000_000_000;
  let connection = { id: "shop-a", status: "active", external_account_id: "42", display_name: "Shopee 42", metadata: {}, token_expires_at: null, token_cipher: "cipher-old", refresh_token_cipher: "refresh-cipher-old", updated_at: "2026-08-17T12:00:00.000Z" };
  let locked = false;
  const waiters = [];
  let refreshCalls = 0;
  let firstRefreshStarted;
  const firstRefreshStartedPromise = new Promise((resolve) => { firstRefreshStarted = resolve; });
  let releaseFirstRefresh;
  const client = createShopeeClient({
    shopeeConfig: { partnerId: "123", partnerKey: "partner-key", apiBase: "https://partner.test", refreshPath: "/refresh" },
    clock: () => fixedNow,
    getConnectionFn: async () => connection,
    tokenValuesFn: () => ({ accessToken: "access", refreshToken: "old-rotating-refresh" }),
    withTenantFn: async (_tenant, _user, work) => {
      while (locked) await new Promise((resolve) => waiters.push(resolve));
      locked = true;
      try { return await work({}); } finally { locked = false; waiters.shift()?.(); }
    },
    upsertConnectionFn: async (_db, _tenant, _channel, data) => {
      connection = { ...connection, token_expires_at: data.tokenExpiresAt, token_cipher: "cipher-new", refresh_token_cipher: "refresh-cipher-new", updated_at: "2026-08-17T12:01:00.000Z" };
      return connection;
    },
    fetchJsonFn: async () => {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        firstRefreshStarted();
        return new Promise((resolve) => { releaseFirstRefresh = () => resolve({ access_token: "new-access", refresh_token: "new-rotating-refresh", expire_in: 3600 }); });
      }
      return { access_token: "unexpected-access", refresh_token: "unexpected-refresh", expire_in: 3600 };
    },
  });
  const auth = { tenantId: "tenant-1", userId: "user-1" };
  const first = client.refreshLocked(auth, "shop-a");
  await firstRefreshStartedPromise;
  const second = client.refreshLocked(auth, "shop-a");
  await Promise.resolve();
  releaseFirstRefresh();
  await Promise.all([first, second]);

  assert.equal(refreshCalls, 1);
});
test("Shopee client envia update_time quando solicitado e nao pede campos pessoais no detalhe", async () => {
  const urls = [];
  const client = createShopeeClient({
    shopeeConfig: {
      partnerId: "123", partnerKey: "partner-key", apiBase: "https://partner.test",
      orderListPath: "/orders", orderDetailPath: "/detail",
    },
    getConnectionFn: async () => ({ id: "shop-a", status: "active", external_account_id: "42", token_expires_at: new Date("2030-01-01") }),
    tokenValuesFn: () => ({ accessToken: "access", refreshToken: "refresh" }),
    fetchJsonFn: async (url) => { urls.push(new URL(String(url))); return { response: { order_list: [] } }; },
  });
  const auth = { tenantId: "tenant-1", userId: "user-1" };
  await client.listOrders(auth, { connectionId: "shop-a", from: "2026-08-01", to: "2026-08-02", timeRangeField: "update_time" });
  await client.orderDetail(auth, ["ORDER-1"], "shop-a");

  assert.equal(urls[0].searchParams.get("time_range_field"), "update_time");
  const optional = urls[1].searchParams.get("response_optional_fields");
  assert.match(optional, /item_list/);
  assert.doesNotMatch(optional, /buyer|recipient|invoice|credit.?card/i);
});
