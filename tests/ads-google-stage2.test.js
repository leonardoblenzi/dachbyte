"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Google Ads stage 2 persists encrypted credentials and normalized read-only data", () => {
  const migration = read("apps/ads/db/002_google_ads.sql");
  for (const table of [
    "ads_provider_credentials",
    "ads_campaigns",
    "ads_ad_groups",
    "ads_ads",
    "ads_google_keywords",
    "ads_conversion_actions",
    "ads_metrics_daily",
    "ads_google_search_terms_daily",
    "ads_sync_cursors",
    "ads_sync_jobs",
  ]) assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));

  assert.match(migration, /access_token_ciphertext/);
  assert.match(migration, /refresh_token_ciphertext/);
  assert.match(migration, /ads_provider_credentials ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /ads_metrics_daily ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /Control-plane queue/);
  assert.doesNotMatch(migration, /access_token\s+text\s*[,)]/i);
});

test("DACH Ads token vault encrypts with authenticated encryption and refuses plaintext decrypt", () => {
  const previous = process.env.ADS_TOKEN_ENCRYPTION_KEY;
  process.env.ADS_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  delete require.cache[require.resolve("../apps/ads/config/env")];
  delete require.cache[require.resolve("../apps/ads/infrastructure/security/tokenVault")];
  const vault = require("../apps/ads/infrastructure/security/tokenVault");
  const encrypted = vault.encrypt("refresh-token-secret");
  assert.match(encrypted, /^dach::ads::v1::/);
  assert.equal(vault.decrypt(encrypted), "refresh-token-secret");
  assert.throws(() => vault.decrypt("refresh-token-secret"), /plaintext/);
  if (previous === undefined) delete process.env.ADS_TOKEN_ENCRYPTION_KEY;
  else process.env.ADS_TOKEN_ENCRYPTION_KEY = previous;
});

test("Google Ads OAuth requests offline adwords access and the API adapter targets v25", () => {
  const previous = {
    GOOGLE_ADS_CLIENT_ID: process.env.GOOGLE_ADS_CLIENT_ID,
    GOOGLE_ADS_CLIENT_SECRET: process.env.GOOGLE_ADS_CLIENT_SECRET,
    GOOGLE_ADS_REDIRECT_URI: process.env.GOOGLE_ADS_REDIRECT_URI,
    GOOGLE_ADS_API_VERSION: process.env.GOOGLE_ADS_API_VERSION,
  };
  process.env.GOOGLE_ADS_CLIENT_ID = "client-id";
  process.env.GOOGLE_ADS_CLIENT_SECRET = "client-secret";
  process.env.GOOGLE_ADS_REDIRECT_URI = "https://example.test/ads/api/google/oauth/callback";
  process.env.GOOGLE_ADS_API_VERSION = "v25";
  delete require.cache[require.resolve("../apps/ads/config/env")];
  delete require.cache[require.resolve("../apps/ads/infrastructure/google/googleOAuthClient")];
  delete require.cache[require.resolve("../apps/ads/infrastructure/google/googleAdsClient")];
  const oauth = require("../apps/ads/infrastructure/google/googleOAuthClient");
  const { GoogleAdsClient } = require("../apps/ads/infrastructure/google/googleAdsClient");
  const url = new URL(oauth.buildAuthorizationUrl("state-123"));
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.match(url.searchParams.get("prompt"), /consent/);
  assert.match(url.searchParams.get("scope"), /auth\/adwords/);
  const client = new GoogleAdsClient({ accessToken: "x", apiVersion: "v25" });
  assert.equal(client.apiVersion, "v25");
  assert.equal(client.headers("123-456-7890")["login-customer-id"], "1234567890");
  assert.equal(client.headers()["developer-token"], undefined);
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("Google Ads UI exposes account selection but never renders provider credentials", () => {
  const html = read("apps/ads/public/app.html");
  const js = read("apps/ads/public/google-ads.js");
  assert.match(html, /href="\/ads\/app\/google"/);
  assert.match(html, /data-google-connect/);
  assert.match(html, /data-google-accounts/);
  assert.match(js, /\/ads\/api\/google\/oauth\/start/);
  assert.match(js, /accounts\/.*\/selection/);
  assert.doesNotMatch(html + js, /refresh_token|access_token_ciphertext|client_secret/i);
});

test("authenticated app subroutes reuse the DACH Ads shell without requiring Google configuration", async () => {
  const previous = { NODE_ENV: process.env.NODE_ENV, ADS_AUTH_MODE: process.env.ADS_AUTH_MODE };
  process.env.NODE_ENV = "development";
  process.env.ADS_AUTH_MODE = "development";
  delete require.cache[require.resolve("../apps/ads/config/env")];
  delete require.cache[require.resolve("../apps/ads/infrastructure/identity/createIdentityProvider")];
  delete require.cache[require.resolve("../apps/ads/app")];
  const { createAdsApp } = require("../apps/ads/app");
  const server = createAdsApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/ads/app/google`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /data-ads-view="google"/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.NODE_ENV;
    if (previous.ADS_AUTH_MODE === undefined) delete process.env.ADS_AUTH_MODE; else process.env.ADS_AUTH_MODE = previous.ADS_AUTH_MODE;
  }
});
