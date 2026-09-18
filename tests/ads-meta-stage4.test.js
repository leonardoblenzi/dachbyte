"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Meta stage 4 adds read-only Meta data structures with tenant RLS", () => {
  const migration = read("apps/ads/db/003_meta_ads.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ads_meta_businesses/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ads_meta_creatives/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ads_meta_action_metrics_daily/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS reach bigint/);
  assert.match(migration, /ads_meta_businesses ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /ads_meta_creatives ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /ads_meta_action_metrics_daily ENABLE ROW LEVEL SECURITY/);
});

test("Meta OAuth uses Graph v26 and requests read-only ads/business scopes", () => {
  const previous = {
    META_APP_ID: process.env.META_APP_ID,
    META_APP_SECRET: process.env.META_APP_SECRET,
    META_REDIRECT_URI: process.env.META_REDIRECT_URI,
    META_GRAPH_API_VERSION: process.env.META_GRAPH_API_VERSION,
    META_OAUTH_SCOPES: process.env.META_OAUTH_SCOPES,
  };
  process.env.META_APP_ID = "app-123";
  process.env.META_APP_SECRET = "secret";
  process.env.META_REDIRECT_URI = "https://example.test/ads/api/meta/oauth/callback";
  process.env.META_GRAPH_API_VERSION = "v26.0";
  process.env.META_OAUTH_SCOPES = "ads_read,business_management";
  delete require.cache[require.resolve("../apps/ads/config/env")];
  delete require.cache[require.resolve("../apps/ads/infrastructure/meta/metaOAuthClient")];
  const oauth = require("../apps/ads/infrastructure/meta/metaOAuthClient");
  const url = new URL(oauth.buildAuthorizationUrl("state-123"));
  assert.match(url.pathname, /v26\.0\/dialog\/oauth/);
  assert.equal(url.searchParams.get("client_id"), "app-123");
  assert.match(url.searchParams.get("scope"), /ads_read/);
  assert.match(url.searchParams.get("scope"), /business_management/);
  assert.doesNotMatch(url.searchParams.get("scope"), /ads_management/);
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("Meta insights parser preserves action types instead of inventing one conversion total", () => {
  const { parseInsightsRow, moneyToMicros } = require("../apps/ads/infrastructure/meta/metaGraphClient");
  const parsed = parseInsightsRow({
    date_start: "2026-09-17",
    account_id: "123",
    impressions: "1000",
    clicks: "50",
    spend: "123.45",
    reach: "800",
    frequency: "1.25",
    actions: [
      { action_type: "lead", value: "7" },
      { action_type: "purchase", value: "2" },
    ],
    action_values: [{ action_type: "purchase", value: "400" }],
  }, "account", "123");
  assert.equal(parsed.metric.cost_micros, "123450000");
  assert.equal(parsed.metric.conversions, "0");
  assert.equal(parsed.metric.reach, "800");
  assert.equal(parsed.actionMetrics.length, 2);
  assert.deepEqual(parsed.actionMetrics.find((item) => item.action_type === "purchase"), {
    metric_date: "2026-09-17",
    entity_type: "account",
    entity_external_id: "123",
    action_type: "purchase",
    action_count: "2",
    action_value: "400",
  });
  assert.equal(moneyToMicros("1.01"), "1010000");
});

test("Meta UI and API are wired without exposing provider credentials", () => {
  const app = read("apps/ads/app.js");
  const html = read("apps/ads/public/app.html");
  const shell = read("apps/ads/public/ads-shell.js");
  const js = read("apps/ads/public/meta-ads.js");
  assert.match(app, /createMetaAdsRouter/);
  assert.match(app, /\/ads\/api\/meta/);
  assert.match(html, /data-ads-view="meta"/);
  assert.match(html, /data-meta-connect/);
  assert.match(html, /data-meta-businesses/);
  assert.match(html, /data-meta-accounts/);
  assert.match(js, /\/ads\/api\/meta\/oauth\/start/);
  assert.match(shell, /startsWith\("\/ads\/app\/meta"\)/);
  assert.doesNotMatch(html + js, /access_token_ciphertext|client_secret|META_APP_SECRET/);
});

test("Ads worker dispatches both Google and Meta jobs fairly", () => {
  const worker = read("apps/ads/worker.js");
  assert.match(worker, /GoogleAdsSyncRepository/);
  assert.match(worker, /MetaAdsSyncRepository/);
  assert.match(worker, /provider: "google_ads"/);
  assert.match(worker, /provider: "meta_ads"/);
  assert.match(worker, /providerCursor/);
});
