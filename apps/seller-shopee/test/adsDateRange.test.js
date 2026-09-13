"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const AdsController = require("../src/controllers/AdsController");
const AdsIntelligenceAutomationService = require(
  "../src/services/AdsIntelligenceAutomationService",
);

test("preserva os 31 dias de um mes civil completo no filtro de Ads", () => {
  const normalizers = [
    AdsController._test.normalizeAdsDateRange,
    AdsIntelligenceAutomationService._test.normalizeAdsDateRange,
  ];

  for (const normalize of normalizers) {
    const range = normalize("2026-08-01", "2026-08-31");
    assert.equal(range.dateFrom, "2026-08-01");
    assert.equal(range.dateTo, "2026-08-31");
    assert.equal(range.totalDays, 31);
    assert.equal(range.truncated, false);
  }
});
