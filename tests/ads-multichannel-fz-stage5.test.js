"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { MultichannelAnalyticsService } = require("../apps/ads/application/analytics/multichannelAnalyticsService");
const { evaluateFzRules, conversionComparable } = require("../apps/ads/application/diagnostics/fzRulesEngine");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("stage 5 persists business targets, conversion mappings and auditable FZ findings with tenant RLS", () => {
  const migration = read("apps/ads/db/004_multichannel_fz.sql");
  for (const table of ["ads_business_targets", "ads_conversion_mappings", "ads_fz_rule_runs", "ads_fz_findings"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /ads_conversion_mappings_primary_uidx/);
  assert.match(migration, /ads_business_targets ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /ads_fz_findings ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /recommended_action/);
  assert.match(migration, /do_not_change/);
  assert.match(migration, /next_decision/);
});

test("multichannel analytics anchors Google and Meta to the same latest comparable date and never invents combined conversions", async () => {
  const repo = {
    listAccounts: async () => [
      { id: "g1", provider: "google_ads", currency_code: "BRL" },
      { id: "m1", provider: "meta_ads", currency_code: "BRL" },
    ],
    getLatestMetricDates: async () => ({ google_ads: "2026-09-17", meta_ads: "2026-09-18" }),
    getTargets: async () => ({ currency_code: "BRL", target_cpa: "35", target_roas: "4" }),
    listMetaActionTypes: async () => [{ ad_account_id: "m1", action_type: "lead", is_primary: true }],
    getProviderSummary: async (_t,_w,provider,start) => provider === "google_ads"
      ? { cost_micros: start === "2026-08-19" ? "350000000" : "300000000", impressions: "1000", clicks: "100", conversions: "10", conversion_value: "1400" }
      : { cost_micros: "200000000", impressions: "2000", clicks: "80", conversions: "0", conversion_value: "0" },
    getMetaPrimaryConversions: async () => ({ conversions: "8", conversion_value: "800", mapped_accounts: 1 }),
    getMetaFrequencySummary: async () => ({ frequency: "2.5" }),
  };
  const workspaceRepo = { ensureDefaultWorkspace: async () => ({ id: "w1" }) };
  const service = new MultichannelAnalyticsService(repo, workspaceRepo);
  const data = await service.getContext({ tenantId: "t1", userId: "u1" }, { range: 30 });
  assert.equal(data.period.endDate, "2026-09-17");
  assert.equal(data.period.startDate, "2026-08-19");
  assert.equal(data.channels.google_ads.summary.current.spend, 350);
  assert.equal(data.channels.meta_ads.summary.current.conversions, 8);
  assert.equal(data.combined.spend, 550);
  assert.equal(data.combined.conversions, null);
  assert.match(data.combined.notice, /não soma conversões/i);
});

test("FZ rules distinguish missing Meta mapping, scale guard and search-term review without auto-negative claims", () => {
  const context = {
    available: true, rangeDays: 30, period: { startDate: "2026-08-19", endDate: "2026-09-17" },
    targets: { targetCpa: 35, targetRoas: null },
    channels: {
      google_ads: {
        provider: "google_ads", accounts: [{ id: "g1" }],
        summary: { current: { spend: 100, conversions: 4, cpa: 25, roas: null }, delta: {} },
      },
      meta_ads: {
        provider: "meta_ads", accounts: [{ id: "m1" }], conversionMapping: { mappedAccounts: 0, totalAccounts: 1 },
        summary: { current: { spend: 120, conversions: 0, cpa: null, roas: null }, delta: {} },
      },
    },
  };
  const findings = evaluateFzRules(context, { googleZeroConversionSearchTerms: [
    { search_term: "curso barbeiro", campaign_name: "Search", cost_micros: "30000000", clicks: "8" },
  ] });
  assert.ok(findings.some((item) => item.ruleId === "FZ-SCALE-001"));
  assert.ok(findings.some((item) => item.ruleId === "FZ-META-CONV-001"));
  const search = findings.find((item) => item.ruleId === "FZ-GOOGLE-SEARCH-001");
  assert.ok(search);
  assert.match(search.recommendedAction, /negative somente/i);
  assert.equal(conversionComparable(context.channels.meta_ads), false);
});

test("stage 5 UI and API expose multichannel analytics and deterministic diagnostics", () => {
  const app = read("apps/ads/app.js");
  const html = read("apps/ads/public/app.html");
  const shell = read("apps/ads/public/ads-shell.js");
  const multi = read("apps/ads/public/multichannel.js");
  const diagnostics = read("apps/ads/public/diagnostics.js");
  assert.match(app, /createIntelligenceRouter/);
  assert.match(app, /createDiagnosticsRouter/);
  assert.match(app, /\/ads\/api\/intelligence/);
  assert.match(app, /\/ads\/api\/diagnostics/);
  assert.match(html, /data-multichannel-status/);
  assert.match(html, /data-target-form/);
  assert.match(html, /data-meta-conversion-mappings/);
  assert.match(html, /data-ads-view="diagnostics"/);
  assert.match(html, /data-run-diagnostics/);
  assert.match(shell, /\/ads\/app\/diagnostics/);
  assert.match(multi, /combined/);
  assert.match(diagnostics, /Ação recomendada/);
  assert.doesNotMatch(html + multi + diagnostics, /ads_management|pause_campaign|change_budget/);
});
