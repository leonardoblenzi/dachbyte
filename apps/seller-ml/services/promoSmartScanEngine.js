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
  const scannedCount = Math.max(0, finiteNumber(input.scannedCount) ?? collectedCount);
  const total = finiteNumber(input.total);
  const offset = Math.max(0, finiteNumber(input.offset) || 0);
  const returnedLimit = Math.max(1, finiteNumber(input.returnedLimit) || rowsCount || 1);

  if (total != null && scannedCount < total) {
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

async function collectPages(options = {}) {
  if (typeof options.fetchPage !== "function") throw new TypeError("fetchPage é obrigatório.");
  const maxPages = Math.max(1, Number(options.maxPages || 1));
  const rowKey = typeof options.rowKey === "function" ? options.rowKey : (row) => JSON.stringify(row);
  const onCheckpoint = typeof options.onCheckpoint === "function" ? options.onCheckpoint : async () => {};
  const shouldCancel = typeof options.shouldCancel === "function" ? options.shouldCancel : async () => false;
  const rows = [...(Array.isArray(options.seedRows) ? options.seedRows : [])];
  const seenRows = new Set();
  for (const row of rows) seenRows.add(String(rowKey(row)));
  const seenCursors = new Set();
  let cursor = options.cursor || null;
  let offset = Math.max(0, Number(options.offset || 0));
  let scannedCount = Math.max(0, Number(options.scannedCount || 0));
  let expected = finiteNumber(options.total);
  let strategy = cursor ? "cursor" : "offset";
  let lastDecision = null;
  let pagesProcessed = 0;

  for (let page = 0; page < maxPages; page += 1) {
    if (await shouldCancel()) {
      lastDecision = { done: true, coverage: COVERAGE.PARTIAL, reason: "cancelled" };
      break;
    }
    const payload = await options.fetchPage({ page, cursor, offset, strategy });
    pagesProcessed = page + 1;
    const pageRows = Array.isArray(payload?.rows) ? payload.rows : [];
    let addedCount = 0;
    for (const row of pageRows) {
      const key = String(rowKey(row));
      if (seenRows.has(key)) continue;
      seenRows.add(key);
      rows.push(row);
      addedCount += 1;
    }
    scannedCount += pageRows.length;
    const pageTotal = finiteNumber(payload?.total);
    if (pageTotal != null) expected = pageTotal;
    const decision = nextPage({
      rowsCount: pageRows.length,
      addedCount,
      collectedCount: rows.length,
      scannedCount,
      total: expected,
      offset,
      returnedLimit: payload?.returnedLimit,
      nextCursor: payload?.nextCursor,
      seenCursors,
    });
    lastDecision = decision;
    if (!decision.done && decision.strategy === "cursor") {
      seenCursors.add(decision.cursor);
      cursor = decision.cursor;
      strategy = "cursor";
    } else if (!decision.done) {
      offset = decision.offset;
      cursor = null;
      strategy = "offset";
    }

    const checkpoint = {
      cursor,
      offset,
      strategy,
      pages: page + 1,
      scanned: scannedCount,
      collected: rows.length,
      expected,
      coverage: decision.done ? decision.coverage : COVERAGE.PARTIAL,
      reason: decision.reason || null,
      rows: [...rows],
    };
    await onCheckpoint(checkpoint);
    if (decision.done) break;
  }

  if (!lastDecision?.done) {
    lastDecision = { done: true, coverage: COVERAGE.PARTIAL, reason: "page_budget_reached" };
  }
  return {
    rows,
    coverage: {
      state: lastDecision.coverage,
      reason: lastDecision.reason,
      expected,
      collected: rows.length,
      scanned: scannedCount,
      pages: pagesProcessed,
    },
  };
}

function filterVerifiedOpportunities(opportunities, selectedIds) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  return (Array.isArray(opportunities) ? opportunities : []).filter((opportunity) =>
    ids.has(String(opportunity?.id || ""))
    && opportunity?.classification === "verified"
    && opportunity?.coverage_verified === true
  );
}

module.exports = {
  COVERAGE,
  POLICIES,
  normalizeMode,
  planCampaigns,
  nextPage,
  collectPages,
  filterVerifiedOpportunities,
  _test: { campaignInterval, intervalsOverlap, normalizedStatus },
};
