"use strict";

const COVERAGE = Object.freeze({
  COMPLETE: "complete",
  PARTIAL: "partial",
  INCONCLUSIVE: "inconclusive",
  INDETERMINATE: "indeterminate",
});

const POLICIES = Object.freeze({
  quick: Object.freeze({
    maxDurationMs: Math.max(30000, Number(process.env.PROMO_SMART_QUICK_MAX_DURATION_MS || 120000)),
    maxPagesPerCampaign: Math.max(1, Number(process.env.PROMO_SMART_QUICK_MAX_PAGES || 20)),
    retryRounds: 1,
  }),
  full: Object.freeze({
    maxDurationMs: 0,
    maxPagesPerCampaign: Math.max(1, Number(process.env.PROMO_SMART_ANALYSIS_MAX_PAGES || 250)),
    retryRounds: 3,
  }),
});

function normalizeMode(value = "quick") {
  const mode = String(value || "quick").trim().toLowerCase();
  if (!Object.hasOwn(POLICIES, mode)) {
    throw new Error("Modo de verificação SMART inválido. Use quick ou full.");
  }
  return mode;
}

function dateMs(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function campaignInterval(campaign = {}) {
  return {
    start: dateMs(campaign.start_date || campaign.valid_from || campaign.date_from || campaign.start),
    finish: dateMs(campaign.finish_date || campaign.end_date || campaign.valid_to || campaign.date_to || campaign.finish),
  };
}

function intervalsOverlap(left, right) {
  if (left.start == null || left.finish == null || right.start == null || right.finish == null) return false;
  return left.start <= right.finish && right.start <= left.finish;
}

function normalizedStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (status === "active") return "started";
  if (["programmed", "scheduled", "in_progress"].includes(status)) return "pending";
  return status;
}

function planCampaigns(campaigns, { mode = "quick" } = {}) {
  const selectedMode = normalizeMode(mode);
  const rows = [...(Array.isArray(campaigns) ? campaigns : [])];
  if (selectedMode === "full") return rows;

  const intervals = rows.map(campaignInterval);
  const overlapScores = rows.map((_row, index) => intervals.reduce(
    (score, interval, otherIndex) => score + (
      index !== otherIndex
      && normalizedStatus(rows[otherIndex]?.status) === "started"
      && intervalsOverlap(intervals[index], interval)
        ? 1
        : 0
    ),
    0,
  ));

  return rows
    .map((row, index) => ({ row, index, overlapScore: overlapScores[index] }))
    .sort((left, right) => {
      const leftActive = normalizedStatus(left.row?.status) === "started" ? 0 : 1;
      const rightActive = normalizedStatus(right.row?.status) === "started" ? 0 : 1;
      return leftActive - rightActive || right.overlapScore - left.overlapScore || left.index - right.index;
    })
    .map((entry) => entry.row);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nextPage(input = {}) {
  const nextCursor = input.nextCursor == null ? null : String(input.nextCursor).trim() || null;
  if (nextCursor) {
    if (input.seenCursors?.has(nextCursor)) {
      return { done: true, coverage: COVERAGE.INCONCLUSIVE, reason: "repeated_cursor" };
    }
    return { done: false, strategy: "cursor", cursor: nextCursor };
  }

  const rowsCount = Math.max(0, finiteNumber(input.rowsCount) || 0);
  const collectedCount = Math.max(0, finiteNumber(input.collectedCount) || 0);
  const total = finiteNumber(input.total);
  const offset = Math.max(0, finiteNumber(input.offset) || 0);
  const returnedLimit = Math.max(1, finiteNumber(input.returnedLimit) || rowsCount || 1);

  if (total != null && collectedCount < total) {
    return { done: false, strategy: "offset", offset: offset + returnedLimit };
  }
  if (total != null) {
    return { done: true, coverage: COVERAGE.COMPLETE, reason: "declared_total_reached" };
  }
  if (rowsCount === 0) {
    return { done: true, coverage: COVERAGE.COMPLETE, reason: "empty_terminal_page" };
  }
  return { done: true, coverage: COVERAGE.INDETERMINATE, reason: "no_continuation_evidence" };
}

module.exports = {
  COVERAGE,
  POLICIES,
  normalizeMode,
  planCampaigns,
  nextPage,
  _test: { campaignInterval, intervalsOverlap, normalizedStatus },
};
