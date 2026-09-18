"use strict";

const ALLOWED_RANGES = new Set([7, 14, 30]);

function isoDate(date) { return date.toISOString().slice(0, 10); }
function addDays(iso, days) {
  const date = new Date(`${iso}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}
function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function zero(value) { return num(value) ?? 0; }
function delta(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  const a = Number(current); const b = Number(previous);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (b === 0) return a === 0 ? 0 : null;
  return (a - b) / Math.abs(b);
}
function baseMetrics(row = {}, conversionOverride = null) {
  const impressions = zero(row.impressions);
  const clicks = zero(row.clicks);
  const spend = zero(row.cost_micros) / 1_000_000;
  const conversions = conversionOverride ? zero(conversionOverride.conversions) : zero(row.conversions);
  const conversionValue = conversionOverride ? zero(conversionOverride.conversion_value) : zero(row.conversion_value);
  return {
    impressions,
    clicks,
    spend,
    conversions,
    conversionValue,
    ctr: impressions > 0 ? clicks / impressions : 0,
    cpc: clicks > 0 ? spend / clicks : null,
    cpa: conversions > 0 ? spend / conversions : null,
    roas: spend > 0 && conversionValue > 0 ? conversionValue / spend : null,
    conversionRate: clicks > 0 ? conversions / clicks : null,
  };
}
function comparison(current, previous) {
  const keys = ["impressions","clicks","spend","conversions","conversionValue","ctr","cpc","cpa","roas","conversionRate","frequency"];
  return { current, previous, delta: Object.fromEntries(keys.map((key) => [key, delta(current?.[key], previous?.[key])])) };
}
function normalizeTarget(row) {
  if (!row) return {
    currencyCode: "BRL", monthlyBudget: null, targetCpa: null, targetRoas: null,
    averageTicket: null, grossMarginPercent: null, notes: null, configured: false,
  };
  return {
    currencyCode: row.currency_code || "BRL",
    monthlyBudget: num(row.monthly_budget),
    targetCpa: num(row.target_cpa),
    targetRoas: num(row.target_roas),
    averageTicket: num(row.average_ticket),
    grossMarginPercent: num(row.gross_margin_percent),
    notes: row.notes || null,
    updatedAt: row.updated_at || null,
    configured: [row.target_cpa, row.target_roas, row.monthly_budget, row.average_ticket, row.gross_margin_percent].some((value) => value !== null && value !== undefined),
  };
}
function inputNumber(value, { min = null, max = null, allowZero = true } = {}) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw Object.assign(new Error("Numeric target is invalid"), { code: "BUSINESS_TARGET_INVALID" });
  if ((!allowZero && parsed <= 0) || (allowZero && min !== null && parsed < min) || (max !== null && parsed > max)) {
    throw Object.assign(new Error("Business target is outside the allowed range"), { code: "BUSINESS_TARGET_INVALID" });
  }
  return parsed;
}

class MultichannelAnalyticsService {
  constructor(repository, workspaceRepository) { this.repository = repository; this.workspaceRepository = workspaceRepository; }

  normalizeRange(value) {
    const parsed = Number.parseInt(String(value || "30"), 10);
    return ALLOWED_RANGES.has(parsed) ? parsed : 30;
  }

  async getContext(identity, input = {}) {
    const workspace = await this.workspaceRepository.ensureDefaultWorkspace(identity);
    const rangeDays = this.normalizeRange(input.range);
    const accounts = await this.repository.listAccounts(identity.tenantId, workspace.id);
    const latestDates = await this.repository.getLatestMetricDates(identity.tenantId, workspace.id);
    const availableDates = Object.values(latestDates).filter(Boolean).sort();
    const targets = normalizeTarget(await this.repository.getTargets(identity.tenantId, workspace.id));
    const actionTypes = await this.repository.listMetaActionTypes(identity.tenantId, workspace.id);

    if (!accounts.length || !availableDates.length) {
      return { available: false, reason: !accounts.length ? "no_synced_accounts" : "no_synced_metrics", workspace, accounts, rangeDays, targets, actionTypes };
    }

    // Anchor multichannel comparison to the oldest "latest" date so channels are
    // compared across the same calendar window instead of mixing data freshness.
    const endDate = availableDates[0];
    const startDate = addDays(endDate, -(rangeDays - 1));
    const previousEndDate = addDays(startDate, -1);
    const previousStartDate = addDays(previousEndDate, -(rangeDays - 1));

    const providerAccounts = {
      google_ads: accounts.filter((item) => item.provider === "google_ads"),
      meta_ads: accounts.filter((item) => item.provider === "meta_ads"),
    };

    const channelResults = {};
    for (const provider of ["google_ads", "meta_ads"]) {
      if (!providerAccounts[provider].length || !latestDates[provider]) continue;
      const [currentRaw, previousRaw] = await Promise.all([
        this.repository.getProviderSummary(identity.tenantId, workspace.id, provider, startDate, endDate),
        this.repository.getProviderSummary(identity.tenantId, workspace.id, provider, previousStartDate, previousEndDate),
      ]);

      let currentConversion = null; let previousConversion = null; let mapping = null;
      if (provider === "meta_ads") {
        [currentConversion, previousConversion] = await Promise.all([
          this.repository.getMetaPrimaryConversions(identity.tenantId, workspace.id, startDate, endDate),
          this.repository.getMetaPrimaryConversions(identity.tenantId, workspace.id, previousStartDate, previousEndDate),
        ]);
        mapping = {
          mappedAccounts: Number(currentConversion?.mapped_accounts || 0),
          totalAccounts: providerAccounts[provider].length,
        };
        if (!mapping.mappedAccounts) { currentConversion = null; previousConversion = null; }
      }

      const current = baseMetrics(currentRaw, currentConversion);
      const previous = baseMetrics(previousRaw, previousConversion);
      if (provider === "meta_ads") {
        const [freqCurrent, freqPrevious] = await Promise.all([
          this.repository.getMetaFrequencySummary(identity.tenantId, workspace.id, startDate, endDate),
          this.repository.getMetaFrequencySummary(identity.tenantId, workspace.id, previousStartDate, previousEndDate),
        ]);
        current.frequency = zero(freqCurrent?.frequency);
        previous.frequency = zero(freqPrevious?.frequency);
      }

      const currencies = [...new Set(providerAccounts[provider].map((item) => item.currency_code).filter(Boolean))];
      channelResults[provider] = {
        provider,
        accounts: providerAccounts[provider],
        currencyCode: currencies.length === 1 ? currencies[0] : null,
        currencyMismatch: currencies.length > 1,
        conversionMapping: mapping,
        latestMetricDate: latestDates[provider],
        summary: comparison(current, previous),
      };
    }

    const currencies = [...new Set(accounts.map((item) => item.currency_code).filter(Boolean))];
    const comparableCurrency = currencies.length === 1 ? currencies[0] : null;
    const combinedSpend = comparableCurrency
      ? Object.values(channelResults).reduce((sum, item) => sum + zero(item.summary.current.spend), 0)
      : null;

    return {
      available: true,
      workspace,
      accounts,
      rangeDays,
      period: { startDate, endDate },
      previousPeriod: { startDate: previousStartDate, endDate: previousEndDate },
      freshness: { latestByProvider: latestDates, comparisonAnchorDate: endDate },
      targets,
      actionTypes,
      channels: channelResults,
      combined: {
        currencyCode: comparableCurrency,
        currencyMismatch: currencies.length > 1,
        spend: combinedSpend,
        conversions: null,
        conversionValue: null,
        notice: "O DACH Ads não soma conversões de Google e Meta: as plataformas podem atribuir a mesma venda/lead. Totais de negócio exigem uma fonte deduplicada externa.",
      },
    };
  }

  async saveTargets(identity, input = {}) {
    const workspace = await this.workspaceRepository.ensureDefaultWorkspace(identity);
    const currencyCode = String(input.currencyCode || "BRL").trim().toUpperCase().slice(0, 3) || "BRL";
    const row = await this.repository.upsertTargets(identity.tenantId, workspace.id, identity.userId, {
      currencyCode,
      monthlyBudget: inputNumber(input.monthlyBudget, { min: 0 }),
      targetCpa: inputNumber(input.targetCpa, { allowZero: false }),
      targetRoas: inputNumber(input.targetRoas, { allowZero: false }),
      averageTicket: inputNumber(input.averageTicket, { min: 0 }),
      grossMarginPercent: inputNumber(input.grossMarginPercent, { min: 0, max: 100 }),
      notes: input.notes ? String(input.notes).trim().slice(0, 2000) : null,
    });
    return normalizeTarget(row);
  }

  async saveMetaPrimaryConversion(identity, accountId, input = {}) {
    const workspace = await this.workspaceRepository.ensureDefaultWorkspace(identity);
    const semantic = new Set(["lead","purchase","message","appointment","call","custom"]).has(input.semanticType) ? input.semanticType : "custom";
    const sourceKey = input.sourceKey ? String(input.sourceKey).trim() : null;
    const result = await this.repository.setMetaPrimaryConversion(identity.tenantId, workspace.id, String(accountId), {
      sourceKey,
      semanticType: semantic,
      label: input.label ? String(input.label).trim().slice(0, 250) : sourceKey,
    });
    if (!result) {
      const error = new Error("Meta Ads account not found or not selected for synchronization");
      error.code = "META_ACCOUNT_NOT_FOUND";
      throw error;
    }
    return result;
  }
}

module.exports = { MultichannelAnalyticsService, baseMetrics, comparison, normalizeTarget, addDays };
