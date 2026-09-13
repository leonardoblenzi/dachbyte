"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../src/services/PricingV7CalibrationService");

test("V7 consolida linhas repetidas do mesmo item e variação antes da recalibração", () => {
  const rows = _test.mapOrderRows({
    id: 321,
    orderSn: "260820DUPLICADO",
    orderStatus: "COMPLETED",
    incomeSyncedAt: "2026-08-20T12:00:00.000Z",
    totalAmountCents: 30000,
    incomeNetCents: 24000,
    items: [
      { id: 1, itemId: 99, modelId: 7, orderPrice: 10000, productCostCents: 4000 },
      { id: 2, itemId: 99, modelId: 7, orderPrice: 20000, productCostCents: 4000 },
    ],
  }, 0.1);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].itemId, 99);
  assert.equal(rows[0].modelId, 7);
  assert.equal(rows[0].promotionalPriceCents, 30000);
});

test("V7 mantém linhas sem ID Shopee distintas usando o ID local do item", () => {
  const rows = _test.mapOrderRows({
    id: 322,
    orderSn: "260820SEMID",
    orderStatus: "COMPLETED",
    incomeSyncedAt: "2026-08-20T12:00:00.000Z",
    totalAmountCents: 30000,
    incomeNetCents: 24000,
    items: [
      { id: 11, orderPrice: 10000, productCostCents: 4000 },
      { id: 12, orderPrice: 20000, productCostCents: 4000 },
    ],
  }, 0.1);

  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].itemId, rows[1].itemId);
  assert.ok(rows.every((row) => row.itemId < 0));
});