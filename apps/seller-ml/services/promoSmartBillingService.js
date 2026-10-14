"use strict";

const {
  quoteCredits,
  reserveCredits,
  settleCredits,
} = require("./hubCreditsService");

const OPERATION_KEY = "promotions.smart-optimize";

function normalizeUnits(value) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function idempotencyKey(operationId) {
  const value = String(operationId || "").trim();
  if (!value) throw new Error("smart_optimize_operation_id_required");
  return `${OPERATION_KEY}:${value}`;
}

async function previewCredits({
  mlCreds = {},
  account = null,
  selected = 0,
} = {}) {
  const units = normalizeUnits(selected);
  if (!units) {
    const error = new Error("Selecione ao menos uma oportunidade segura.");
    error.statusCode = 400;
    throw error;
  }

  const quote = await quoteCredits({
    mlCreds,
    account,
    operationKey: OPERATION_KEY,
    units,
  });

  return {
    operation_key: OPERATION_KEY,
    quantity: units,
    estimated_credits: Number(quote?.estimated_credits || 0),
    available_credits:
      quote?.available_credits == null ? null : Number(quote.available_credits),
    sufficient: quote?.sufficient !== false,
    unlimited: quote?.unlimited === true,
    deferred: false,
    quote,
  };
}

async function reserveCreditsForOptimization({
  mlCreds = {},
  account = null,
  selected = 0,
  operationId,
} = {}) {
  const units = normalizeUnits(selected);
  if (!units) throw new Error("smart_optimize_units_required");

  return reserveCredits({
    mlCreds,
    account,
    operationKey: OPERATION_KEY,
    units,
    idempotencyKey: idempotencyKey(operationId),
  });
}

async function settleOptimizationCredits(
  reservation,
  { optimized = 0 } = {},
) {
  const units = normalizeUnits(optimized);
  return settleCredits(reservation, {
    release: units <= 0,
    consumedUnits: units > 0 ? units : null,
  });
}

function telemetry({
  reservation = null,
  operationId = null,
  selected = 0,
  processed = 0,
  optimized = 0,
  failed = 0,
  skipped = 0,
  cancelled = false,
  safetyPaused = false,
  startedAt = null,
  finishedAt = null,
  error = null,
} = {}) {
  const successUnits = normalizeUnits(optimized);
  return {
    billing_mode:
      !reservation || Object.keys(reservation).length === 0
        ? "pending"
        : reservation?.shadow === true
          ? "shadow"
          : reservation?.bypass === true
            ? "bypass"
            : "enforce",
    operation_key: OPERATION_KEY,
    operation_id: operationId || null,
    selected: normalizeUnits(selected),
    processed: Math.max(0, Math.trunc(Number(processed) || 0)),
    optimized: successUnits,
    failed: Math.max(0, Math.trunc(Number(failed) || 0)),
    skipped: Math.max(0, Math.trunc(Number(skipped) || 0)),
    billable_units: successUnits,
    cancelled: cancelled === true,
    safety_paused: safetyPaused === true,
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
  normalizeUnits,
  idempotencyKey,
  previewCredits,
  reserveCreditsForOptimization,
  settleOptimizationCredits,
  telemetry,
};
