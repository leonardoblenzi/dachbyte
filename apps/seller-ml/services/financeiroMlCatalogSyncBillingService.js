"use strict";

const crypto = require("crypto");
const {
  quoteCredits,
  reserveCredits,
  settleCredits,
} = require("./hubCreditsService");

const OPERATION_KEY = "finance.catalog-sync";

function normalizeCount(value) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function operationId() {
  return `FINANCE-CATALOG-SYNC-${crypto.randomUUID()}`;
}

function idempotencyKey(value) {
  const id = String(value || "").trim();
  if (!id) throw new Error("finance_catalog_sync_operation_id_required");
  return `${OPERATION_KEY}:${id}`;
}

function workUnits({ relevantItems = 0, ordersRead = 0 } = {}) {
  return normalizeCount(relevantItems) + normalizeCount(ordersRead);
}

async function previewCredits({
  mlCreds = {},
  account = null,
  alreadyRunning = false,
  relevantItems = null,
  ordersRead = null,
} = {}) {
  if (alreadyRunning) {
    return {
      operation_key: OPERATION_KEY,
      already_running: true,
      deferred: false,
      quantity: 0,
      estimated_credits: 0,
      available_credits: null,
      sufficient: true,
      unlimited: false,
    };
  }

  const knownUnits = workUnits({ relevantItems, ordersRead });
  const quoteUnits = knownUnits > 0 ? knownUnits : 1;
  const quote = await quoteCredits({
    mlCreds,
    account,
    operationKey: OPERATION_KEY,
    units: quoteUnits,
  });

  return {
    operation_key: OPERATION_KEY,
    already_running: false,
    deferred: knownUnits <= 0,
    quantity: knownUnits > 0 ? knownUnits : null,
    relevant_items: normalizeCount(relevantItems) || null,
    orders_read: normalizeCount(ordersRead) || null,
    estimated_credits:
      knownUnits > 0 || quote?.unlimited === true
        ? Number(quote?.estimated_credits || 0)
        : null,
    minimum_estimated_credits:
      knownUnits > 0 ? null : Number(quote?.estimated_credits || 0),
    available_credits:
      quote?.available_credits == null ? null : Number(quote.available_credits),
    sufficient: knownUnits > 0 ? quote?.sufficient !== false : null,
    unlimited: quote?.unlimited === true,
    quote,
  };
}

async function reserveForDiscoveredWork({
  mlCreds = {},
  account = null,
  relevantItems = 0,
  ordersRead = 0,
  operationId: opId,
} = {}) {
  const units = workUnits({ relevantItems, ordersRead });
  if (!units) return null;

  return reserveCredits({
    mlCreds,
    account,
    operationKey: OPERATION_KEY,
    units,
    idempotencyKey: idempotencyKey(opId),
  });
}

async function settleSyncCredits(
  reservation,
  { processedItems = 0, ordersRead = 0 } = {},
) {
  const units = workUnits({
    relevantItems: processedItems,
    ordersRead,
  });
  return settleCredits(reservation, {
    release: units <= 0,
    consumedUnits: units > 0 ? units : null,
  });
}

function telemetry({
  reservation = null,
  operationId: opId = null,
  trigger = "manual",
  relevantItems = 0,
  processedItems = 0,
  ordersRead = 0,
  completed = false,
  failed = false,
  reused = false,
  startedAt = null,
  finishedAt = null,
  error = null,
} = {}) {
  const discoveredUnits = workUnits({ relevantItems, ordersRead });
  const billableUnits =
    trigger === "manual"
      ? workUnits({ relevantItems: processedItems, ordersRead })
      : 0;

  return {
    billing_mode:
      trigger !== "manual"
        ? "internal"
        : !reservation || Object.keys(reservation).length === 0
          ? relevantItems > 0 || ordersRead > 0
            ? "pending"
            : "deferred"
          : reservation?.shadow === true
            ? "shadow"
            : reservation?.bypass === true
              ? "bypass"
              : "enforce",
    operation_key: OPERATION_KEY,
    operation_id: opId || null,
    trigger,
    reused: reused === true,
    relevant_items: normalizeCount(relevantItems),
    processed_items: normalizeCount(processedItems),
    orders_read: normalizeCount(ordersRead),
    reserved_units: trigger === "manual" ? discoveredUnits : 0,
    billable_units: billableUnits,
    completed: completed === true,
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
  normalizeCount,
  operationId,
  idempotencyKey,
  workUnits,
  previewCredits,
  reserveForDiscoveredWork,
  settleSyncCredits,
  telemetry,
};
