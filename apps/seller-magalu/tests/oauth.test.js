"use strict";

process.env.MAGALU_OAUTH_CLIENT_ID = "client-stage2";
process.env.MAGALU_OAUTH_CLIENT_SECRET = "secret-stage2";
process.env.MAGALU_OAUTH_REDIRECT_URI = "https://dachbyte.tech/magalu/auth/callback";
process.env.MAGALU_OAUTH_SCOPES = "open:portfolio-skus-seller:read open:portfolio-prices-seller:read";
process.env.MAGALU_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

const test = require("node:test");
const assert = require("node:assert/strict");
const security = require("../src/services/oauthSecurity");
const oauth = require("../src/services/magaluOAuthProtocol");

function jwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

test("consent URL uses Authorization Code and mandatory choose_tenants=true", () => {
  const url = new URL(oauth.buildConsentUrl({ state: "state-test" }));
  assert.equal(url.origin + url.pathname, "https://id.magalu.com/login");
  assert.equal(url.searchParams.get("client_id"), "client-stage2");
  assert.equal(url.searchParams.get("redirect_uri"), "https://dachbyte.tech/magalu/auth/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("choose_tenants"), "true");
  assert.equal(url.searchParams.get("state"), "state-test");
  assert.match(url.searchParams.get("scope"), /open:portfolio-skus-seller:read/);
});

test("redirect_after remains internal to /magalu", () => {
  assert.equal(security.safeRedirectAfter("/magalu/contas?tab=oauth"), "/magalu/contas?tab=oauth");
  assert.equal(security.safeRedirectAfter("https://evil.test/steal"), "/magalu/contas");
  assert.equal(security.safeRedirectAfter("//evil.test/steal"), "/magalu/contas");
  assert.equal(security.safeRedirectAfter("/ml"), "/magalu/contas");
});

test("oauth state is random and only its SHA-256 representation is persisted", () => {
  const one = security.createOAuthState();
  const two = security.createOAuthState();
  assert.notEqual(one, two);
  assert.ok(one.length >= 40);
  assert.match(security.hashOAuthState(one), /^[a-f0-9]{64}$/);
  assert.equal(security.hashOAuthState(one), security.hashOAuthState(one));
});

test("tenant is extracted from access token sub", () => {
  const token = jwt({ sub: "GENPUB.123e4567-e89b-12d3-a456-426614174000", exp: Math.floor(Date.now() / 1000) + 7200 });
  const parsed = security.extractTenantSubject(token);
  assert.equal(parsed.subject, "GENPUB.123e4567-e89b-12d3-a456-426614174000");
});

test("token set keeps access and refresh expiry without exposing secrets to public config", () => {
  const access = jwt({ sub: "GENPUB.tenant-stage2", exp: Math.floor(Date.now() / 1000) + 7200 });
  const refresh = jwt({ sub: "GENPUB.tenant-stage2", exp: Math.floor(Date.now() / 1000) + 86400 });
  const tokenSet = oauth.normalizeTokenSet({
    access_token: access,
    refresh_token: refresh,
    token_type: "Bearer",
    expires_in: 7200,
    scope: "open:portfolio-skus-seller:read open:portfolio-prices-seller:read",
    created_at: Math.floor(Date.now() / 1000),
  });
  assert.equal(tokenSet.subject, "GENPUB.tenant-stage2");
  assert.equal(tokenSet.tokenType, "Bearer");
  assert.equal(tokenSet.scopes.length, 2);
  assert.ok(tokenSet.accessExpiresAt instanceof Date);
  assert.ok(tokenSet.refreshExpiresAt instanceof Date);
  const config = oauth.publicOAuthConfig();
  assert.equal(config.configured, true);
  assert.equal(Object.prototype.hasOwnProperty.call(config, "client_secret"), false);
});

test("authorization code exchange follows Magalu JSON contract", async () => {
  const originalFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 7200, token_type: "Bearer" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await oauth.exchangeAuthorizationCode("authorization-code");
    assert.equal(captured.url, "https://id.magalu.com/oauth/token");
    assert.equal(captured.options.headers["Content-Type"], "application/json");
    const body = JSON.parse(captured.options.body);
    assert.deepEqual(body, {
      client_id: "client-stage2",
      client_secret: "secret-stage2",
      redirect_uri: "https://dachbyte.tech/magalu/auth/callback",
      code: "authorization-code",
      grant_type: "authorization_code",
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("refresh grant follows x-www-form-urlencoded contract", async () => {
  const originalFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ access_token: "a2", refresh_token: "r2", expires_in: 7200, token_type: "Bearer" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await oauth.refreshTokenGrant("refresh-value");
    assert.equal(captured.options.headers["Content-Type"], "application/x-www-form-urlencoded");
    const form = new URLSearchParams(captured.options.body);
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("client_id"), "client-stage2");
    assert.equal(form.get("client_secret"), "secret-stage2");
    assert.equal(form.get("refresh_token"), "refresh-value");
  } finally {
    global.fetch = originalFetch;
  }
});
