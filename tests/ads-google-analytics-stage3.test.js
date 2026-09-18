"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { GoogleAnalyticsService, metrics, delta, addDays } = require("../apps/ads/application/analytics/googleAnalyticsService");

const ROOT = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("stage 3 analytics route and UI are wired into DACH Ads", () => {
  const app = read("apps/ads/app.js");
  const html = read("apps/ads/public/app.html");
  const shell = read("apps/ads/public/ads-shell.js");
  assert.match(app, /createAnalyticsRouter/);
  assert.match(app, /\/ads\/api\/analytics/);
  assert.match(html, /data-ads-view="analytics"/);
  assert.match(html, /data-analytics-campaigns/);
  assert.match(html, /data-analytics-search-terms/);
  assert.match(html, /analytics\.js/);
  assert.match(shell, /startsWith\("\/ads\/app\/analytics"\)/);
});

test("analytics metric helpers calculate business-facing ratios", () => {
  const value = metrics({ impressions: "1000", clicks: "100", cost_micros: "250000000", conversions: "10", conversion_value: "1000" });
  assert.equal(value.spend, 250);
  assert.equal(value.ctr, 0.1);
  assert.equal(value.cpc, 2.5);
  assert.equal(value.cpa, 25);
  assert.equal(value.roas, 4);
  assert.equal(value.conversionRate, 0.1);
  assert.equal(delta(120, 100), 0.2);
  assert.equal(delta(0, 0), 0);
  assert.equal(delta(10, 0), null);
  assert.equal(addDays("2026-09-18", -29), "2026-08-20");
});

test("analytics service anchors the period to the latest synchronized metric date", async () => {
  const repository = {
    listAccounts: async () => [{ id: "account-1", name: "Conta", currency_code: "BRL", last_synced_at: "2026-09-18T10:00:00Z" }],
    resolveAccount: async () => null,
    getLatestMetricDate: async () => "2026-09-17",
    getSummary: async (_t,_a,start) => start === "2026-08-19" ? { cost_micros: "1000000", clicks: "1", impressions: "10", conversions: "1", conversion_value: "2" } : { cost_micros: "2000000", clicks: "2", impressions: "20", conversions: "1", conversion_value: "4" },
    getDailySeries: async () => [],
    getCampaigns: async () => [],
    getKeywords: async () => [],
    getSearchTerms: async () => [],
    getConversionActions: async () => [],
  };
  const googleRepository = { ensureDefaultWorkspace: async () => ({ id: "workspace-1" }) };
  const service = new GoogleAnalyticsService(repository, googleRepository);
  const payload = await service.getAnalytics({ tenantId: "t1", userId: "u1" }, { range: 30 });
  assert.equal(payload.period.endDate, "2026-09-17");
  assert.equal(payload.period.startDate, "2026-08-19");
  assert.equal(payload.previousPeriod.endDate, "2026-08-18");
  assert.equal(payload.previousPeriod.startDate, "2026-07-20");
  assert.equal(payload.summary.current.spend, 1);
  assert.equal(payload.summary.current.roas, 2);
});

test("analytics service refuses to invent data before a Google account is selected", async () => {
  const service = new GoogleAnalyticsService({ listAccounts: async () => [] }, { ensureDefaultWorkspace: async () => ({ id: "w" }) });
  const payload = await service.getAnalytics({ tenantId: "t", userId: "u" }, { range: 7 });
  assert.equal(payload.available, false);
  assert.equal(payload.reason, "no_google_accounts");
  assert.equal(payload.rangeDays, 7);
});
