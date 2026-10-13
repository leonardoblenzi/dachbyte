"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";

const service = require("../services/financeiroMlService");

test("an active margin search with no matching IDs never includes unrelated orders", async () => {
  const result = await service._test.buildOrderFinancials({
    state: {},
    seller: { id: 123 },
    range: { date_from: "2026-10-09", date_to: "2026-10-12" },
    itemIds: [],
    itemFilterActive: true,
    limit: 10,
    itemsById: new Map(),
    costMap: new Map(),
    taxPct: 0,
    accountKey: null,
    ordersOverride: [{ id: 1, order_items: [{ item: { id: "MLB9999999999" }, quantity: 1, unit_price: 35.9 }] }],
    includeGrossAdjustments: false,
  });

  assert.deepEqual(result.orders, []);
  assert.equal(result.summary.orders_matched, 0);
  assert.equal(result.byItem.size, 0);
});
