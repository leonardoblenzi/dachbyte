"use strict";

const crypto = require("crypto");
const {
  quoteCredits,
  reserveCredits,
  settleCredits,
} = require("./hubCreditsService");

const OPERATION_KEY = "listing.filter";

function normalizeCount(value) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function filterWeight(filters = {}) {
  let weight = 1;
  if (filters?.date_from && filters?.date_to) weight += 1;
  if (filters?.include_visits) weight += 1;
  if (filters?.include_ads) weight += 2;
  if (filters?.include_promos) weight += 1;
  if (filters?.include_category) weight += 1;
  if (filters?.detail_variations) weight += 1;
  return weight;
}

function weightedUnits(filters = {}, itemCount = 0) {
  return normalizeCount(itemCount) * filterWeight(filters);
}

function operationId() {
  return `LISTING-FILTER-${crypto.randomUUID()}`;
}

function idempotencyKey(id) {
  const value = String(id || "").trim();
  if (!value) throw new Error("listing_filter_operation_id_required");
  return `${OPERATION_KEY}:${value}`;
}

async function previewCredits({
  mlCreds = {},
  account = null,
  filters = {},
  itemCount = null,
} = {}) {
  const count = normalizeCount(itemCount);
  const weight = filterWeight(filters);
  const units = count > 0 ? count * weight : 1;
  const quote = await quoteCredits({
    mlCreds,
    account,
    operationKey: OPERATION_KEY,
    units,
  });

  return {
    operation_key: OPERATION_KEY,
    quantity: count || null,
    weight,
    weighted_units: count > 0 ? units : null,
    estimated_credits:
      count > 0 || quote?.unlimited === true
        ? Number(quote?.estimated_credits || 0)
        : null,
    minimum_estimated_credits:
      count > 0 ? null : Number(quote?.estimated_credits || 0),
    available_credits:
      quote?.available_credits == null ? null : Number(quote.available_credits),
    sufficient: count > 0 ? quote?.sufficient !== false : null,
    unlimited: quote?.unlimited === true,
    deferred: count <= 0,
    quote,
  };
}

async function reserveForDiscoveredItems({
  mlCreds = {},
  account = null,
  filters = {},
  itemCount = 0,
  operationId: opId,
} = {}) {
  const count = normalizeCount(itemCount);
  if (!count) return null;
  const units = weightedUnits(filters, count);
  return reserveCredits({
    mlCreds,
    account,
    operationKey: OPERATION_KEY,
    units,
    idempotencyKey: idempotencyKey(opId),
  });
}

async function settleReservation(
  reservation,
  { filters = {}, itemCount = 0, completed = false } = {},
) {
  const units = completed ? weightedUnits(filters, itemCount) : 0;
  return settleCredits(reservation, {
    release: units <= 0,
    consumedUnits: units > 0 ? units : null,
  });
}

function telemetry({
  reservation = null,
  operationId: opId = null,
  filters = {},
  discoveredItems = 0,
  resultRows = 0,
  completed = false,
  cancelled = false,
  failed = false,
  startedAt = null,
  finishedAt = null,
  error = null,
} = {}) {
  const count = normalizeCount(discoveredItems);
  const weight = filterWeight(filters);
  const billableUnits = completed ? weightedUnits(filters, count) : 0;
  return {
    billing_mode:
      !reservation || Object.keys(reservation).length === 0
        ? count > 0
          ? "pending"
          : "deferred"
        : reservation?.shadow === true
          ? "shadow"
          : reservation?.bypass === true
            ? "bypass"
            : "enforce",
    operation_key: OPERATION_KEY,
    operation_id: opId || null,
    discovered_items: count,
    result_rows: normalizeCount(resultRows),
    weight,
    weighted_units: count > 0 ? count * weight : 0,
    billable_units: billableUnits,
    completed: completed === true,
    cancelled: cancelled === true,
    failed: failed === true,
    estimated_credits:
      reservation?.quote?.estimated_credits ??
      reservation?.reserved_credits ??
      null,
    duration_ms:
      startedAt && finishedAt
        ? Math.max(0, Number(finishedAt) - Number(startedAt))
        : null,
    error: error ? String(error).slice(0, 500) : null,
  };
}

module.exports = {
  OPERATION_KEY,
  filterWeight,
  weightedUnits,
  operationId,
  idempotencyKey,
  previewCredits,
  reserveForDiscoveredItems,
  settleReservation,
  telemetry,
};
