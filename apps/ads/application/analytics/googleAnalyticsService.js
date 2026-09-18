"use strict";

const ALLOWED_RANGES = new Set([7, 14, 30]);

function isoDate(date) { return date.toISOString().slice(0, 10); }
function addDays(iso, days) {
  const date = new Date(`${iso}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}
function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
function metrics(row = {}) {
  const impressions = number(row.impressions);
  const clicks = number(row.clicks);
  const spend = number(row.cost_micros) / 1_000_000;
  const conversions = number(row.conversions);
  const conversionValue = number(row.conversion_value);
  return {
    impressions, clicks, spend, conversions, conversionValue,
    ctr: impressions > 0 ? clicks / impressions : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
    cpa: conversions > 0 ? spend / conversions : null,
    roas: spend > 0 ? conversionValue / spend : null,
    conversionRate: clicks > 0 ? conversions / clicks : 0,
  };
}
function delta(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  const a = number(current); const b = number(previous);
  if (b === 0) return a === 0 ? 0 : null;
  return (a - b) / Math.abs(b);
}
function decorate(current, previous) {
  const keys = ["impressions","clicks","spend","conversions","conversionValue","ctr","cpc","cpa","roas","conversionRate"];
  return { current, previous, delta: Object.fromEntries(keys.map((key) => [key, delta(current[key], previous[key])])) };
}
function mapRows(rows) { return rows.map((row) => ({ ...row, ...metrics(row) })); }

class GoogleAnalyticsService {
  constructor(repository, googleRepository) { this.repository = repository; this.googleRepository = googleRepository; }

  normalizeRange(value) {
    const range = Number.parseInt(String(value || "30"), 10);
    return ALLOWED_RANGES.has(range) ? range : 30;
  }

  async getAnalytics(identity, input = {}) {
    const workspace = await this.googleRepository.ensureDefaultWorkspace(identity);
    const accounts = await this.repository.listAccounts(identity.tenantId, workspace.id);
    const rangeDays = this.normalizeRange(input.range);
    if (!accounts.length) return { available: false, reason: "no_google_accounts", accounts: [], rangeDays };

    let account = null;
    if (input.accountId) account = await this.repository.resolveAccount(identity.tenantId, workspace.id, input.accountId);
    if (!account) account = accounts[0];

    const latestDate = await this.repository.getLatestMetricDate(identity.tenantId, account.id);
    if (!latestDate) return { available: false, reason: "no_synced_metrics", accounts, account, rangeDays };

    const endDate = latestDate;
    const startDate = addDays(endDate, -(rangeDays - 1));
    const previousEndDate = addDays(startDate, -1);
    const previousStartDate = addDays(previousEndDate, -(rangeDays - 1));

    const [currentRow, previousRow, daily, campaigns, keywords, searchTerms, conversionActions] = await Promise.all([
      this.repository.getSummary(identity.tenantId, account.id, startDate, endDate),
      this.repository.getSummary(identity.tenantId, account.id, previousStartDate, previousEndDate),
      this.repository.getDailySeries(identity.tenantId, account.id, startDate, endDate),
      this.repository.getCampaigns(identity.tenantId, account.id, startDate, endDate),
      this.repository.getKeywords(identity.tenantId, account.id, startDate, endDate),
      this.repository.getSearchTerms(identity.tenantId, account.id, startDate, endDate),
      this.repository.getConversionActions(identity.tenantId, account.id),
    ]);

    const current = metrics(currentRow); const previous = metrics(previousRow);
    return {
      available: true,
      provider: "google_ads",
      accounts,
      account,
      rangeDays,
      period: { startDate, endDate },
      previousPeriod: { startDate: previousStartDate, endDate: previousEndDate },
      freshness: {
        latestMetricDate: latestDate,
        lastSyncedAt: account.last_synced_at,
        lastSyncStatus: account.last_sync_status,
        lastSyncError: account.last_sync_error,
      },
      summary: decorate(current, previous),
      daily: daily.map((row) => ({ metricDate: row.metric_date, ...metrics(row) })),
      campaigns: mapRows(campaigns),
      keywords: mapRows(keywords),
      searchTerms: mapRows(searchTerms),
      conversionActions,
      attributionNotice: "Conversões e valor são os números reportados pelo Google Ads para esta conta. Não representam, por si só, vendas deduplicadas ou lucro do negócio.",
    };
  }
}

module.exports = { GoogleAnalyticsService, metrics, delta, addDays };
