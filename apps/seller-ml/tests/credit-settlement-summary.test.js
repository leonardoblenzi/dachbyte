"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeCreditSettlement } = require("../services/creditSettlementSummary");

test("resumo de liquidação usa só dados confirmados do Hub", () => {
  const reservation = { reserved_credits: 2, credit_unit_scale: 100 };
  assert.deepEqual(summarizeCreditSettlement(reservation, {
    status: "consumed", reserved_credits: 200, consumed_credits: 130, credit_unit_scale: 100,
  }), { status: "confirmed", reserved_credits: 2, spent_credits: 1.3, released_credits: 0.7 });
  assert.deepEqual(summarizeCreditSettlement(reservation, null), {
    status: "unconfirmed", reserved_credits: 2, spent_credits: null, released_credits: null,
  });
  assert.equal(summarizeCreditSettlement(reservation, { status: "reserved", reserved_credits: 200, consumed_credits: 0 }).status, "unconfirmed");
});
