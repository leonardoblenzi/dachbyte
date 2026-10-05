"use strict";

const crypto = require("crypto");
const {
  quoteCredits,
  reserveCredits,
  settleCredits,
} = require("./hubCreditsService");

const OPERATION_KEY = "listing.clone";

function cloneOperationId(draftId) {
  const id = Math.trunc(Number(draftId));
  if (!Number.isFinite(id) || id <= 0) throw new Error("clone_draft_id_required");
  return `CLONE-${id}-${crypto.randomUUID()}`;
}

function cloneIdempotencyKey(operationId) {
  const id = String(operationId || "").trim();
  if (!id) throw new Error("clone_operation_id_required");
  return `${OPERATION_KEY}:${id}`;
}

async function previewCloneCredits({
  mlCreds = {},
  account = null,
  draftId,
  alreadyPublished = false,
} = {}) {
  const id = Math.trunc(Number(draftId));
  if (!Number.isFinite(id) || id <= 0) {
    const error = new Error("Rascunho invalido para calcular o custo.");
    error.statusCode = 400;
    throw error;
  }

  if (alreadyPublished) {
    return {
      operation_key: OPERATION_KEY,
      draft_id: id,
      quantity: 0,
      estimated_credits: 0,
      available_credits: null,
      sufficient: true,
      unlimited: false,
      already_published: true,
      deferred: false,
    };
  }

  const quote = await quoteCredits({
    mlCreds,
    account,
    operationKey: OPERATION_KEY,
    units: 1,
  });

  return {
    operation_key: OPERATION_KEY,
    draft_id: id,
    quantity: 1,
    estimated_credits: Number(quote?.estimated_credits || 0),
    available_credits:
      quote?.available_credits == null ? null : Number(quote.available_credits),
    sufficient: quote?.sufficient !== false,
    unlimited: quote?.unlimited === true,
    already_published: false,
    deferred: false,
    quote,
  };
}

async function reserveCloneCredits({ mlCreds = {}, draftId, operationId } = {}) {
  const id = Math.trunc(Number(draftId));
  if (!Number.isFinite(id) || id <= 0) throw new Error("clone_draft_id_required");
  return reserveCredits({
    mlCreds,
    operationKey: OPERATION_KEY,
    units: 1,
    idempotencyKey: cloneIdempotencyKey(operationId),
  });
}

async function settleCloneCredits(
  reservation,
  { publishedItemId = null, alreadyPublished = false } = {},
) {
  const published = !!String(publishedItemId || "").trim() && !alreadyPublished;
  return settleCredits(reservation, {
    release: !published,
    consumedUnits: published ? 1 : null,
  });
}

function cloneBillingTelemetry({
  reservation = null,
  operationId = null,
  draftId = null,
  publishedItemId = null,
  alreadyPublished = false,
  publishAttempts = 0,
  validationAttempts = 0,
  startedAt = null,
  finishedAt = null,
  failedAt = null,
  error = null,
} = {}) {
  const published = !!String(publishedItemId || "").trim() && !alreadyPublished;
  return {
    billing_mode:
      !reservation || Object.keys(reservation).length === 0
        ? alreadyPublished
          ? "not_billable"
          : "pending"
        : reservation?.shadow === true
          ? "shadow"
          : reservation?.bypass === true
            ? "bypass"
            : "enforce",
    operation_key: OPERATION_KEY,
    operation_id: operationId || null,
    draft_id: Math.trunc(Number(draftId)) || null,
    selected: alreadyPublished ? 0 : 1,
    processed: alreadyPublished ? 0 : 1,
    published: published ? 1 : 0,
    already_published: alreadyPublished === true,
    billable_units: published ? 1 : 0,
    publish_attempts: Math.max(0, Number(publishAttempts || 0)),
    validation_attempts: Math.max(0, Number(validationAttempts || 0)),
    published_item_id: publishedItemId || null,
    estimated_credits:
      reservation?.quote?.estimated_credits ??
      reservation?.reserved_credits ??
      null,
    duration_ms:
      startedAt && (finishedAt || failedAt)
        ? Math.max(0, Number(finishedAt || failedAt) - Number(startedAt))
        : null,
    error: error ? String(error).slice(0, 500) : null,
  };
}

module.exports = {
  OPERATION_KEY,
  cloneOperationId,
  cloneIdempotencyKey,
  previewCloneCredits,
  reserveCloneCredits,
  settleCloneCredits,
  cloneBillingTelemetry,
};
