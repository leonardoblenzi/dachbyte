"use strict";

const crypto = require("node:crypto");
const { quoteCredits, reserveCredits, settleCredits } = require("./hubCreditsService");

const OPERATION_KEY = "listing.sku-update";

async function quoteSkuCredits({ mlCreds, units, quote = quoteCredits }) {
  const quantity = Math.max(1, Math.trunc(Number(units) || 1));
  const result = await quote({ mlCreds, operationKey: OPERATION_KEY, units: quantity });
  return {
    operation_key: OPERATION_KEY,
    quantity,
    estimated_credits: Number(result.estimated_credits || 0),
    available_credits: result.available_credits == null ? null : Number(result.available_credits),
    sufficient: result.sufficient !== false,
    unlimited: result.unlimited === true,
  };
}

function reserveSkuCredits({ mlCreds, jobId, units, reserve = reserveCredits }) {
  return reserve({
    mlCreds,
    operationKey: OPERATION_KEY,
    units: Math.max(1, Math.trunc(Number(units) || 1)),
    idempotencyKey: `${OPERATION_KEY}:${jobId}:${crypto.randomUUID()}`,
  });
}

async function settleSkuCredits(reservation, appliedRows, settle = settleCredits) {
  if (!reservation) return null;
  const applied = Math.max(0, Math.trunc(Number(appliedRows) || 0));
  if (reservation.bypass || reservation.shadow) return null;
  const result = await settle(reservation, {
    release: applied === 0,
    consumedUnits: applied > 0 ? applied : null,
  });
  if (!result) return {
    status: "pending",
    reserved_credits: Number(reservation.reserved_credits || 0),
    spent_credits: null,
    released_credits: null,
  };
  const scale = Math.max(1, Number(result.credit_unit_scale || reservation.credit_unit_scale || 1));
  const reserved = Number(result.reserved_credits || 0);
  const consumed = Number(result.consumed_credits || 0);
  return {
    status: "confirmed",
    reserved_credits: reserved / scale,
    spent_credits: consumed / scale,
    released_credits: Math.max(0, reserved - consumed) / scale,
  };
}

module.exports = { OPERATION_KEY, quoteSkuCredits, reserveSkuCredits, settleSkuCredits };
