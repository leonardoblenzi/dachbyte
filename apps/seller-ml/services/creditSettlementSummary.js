"use strict";

function summarizeCreditSettlement(reservation, settled) {
  if (!reservation || reservation.bypass || reservation.shadow === true) return null;
  const fallbackReserved = Math.max(0, Number(reservation.reserved_credits || 0));
  const unconfirmed = {
    status: "unconfirmed",
    reserved_credits: fallbackReserved,
    spent_credits: null,
    released_credits: null,
  };
  if (!settled || !["consumed", "released"].includes(String(settled.status || ""))) return unconfirmed;
  if (settled.reserved_credits == null || settled.consumed_credits == null) return unconfirmed;
  const scale = Math.max(1, Number(settled.credit_unit_scale || reservation.credit_unit_scale || 1));
  const reservedUnits = Number(settled.reserved_credits);
  const spentUnits = settled.status === "released" ? 0 : Number(settled.consumed_credits);
  if (!Number.isFinite(reservedUnits) || !Number.isFinite(spentUnits) || spentUnits < 0 || spentUnits > reservedUnits) return unconfirmed;
  return {
    status: "confirmed",
    reserved_credits: reservedUnits / scale,
    spent_credits: spentUnits / scale,
    released_credits: (reservedUnits - spentUnits) / scale,
  };
}

module.exports = { summarizeCreditSettlement };
