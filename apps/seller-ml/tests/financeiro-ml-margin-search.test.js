"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";

const service = require("../services/financeiroMlService");

test("classifies exact MLB, ambiguous one-word SKU and multi-word text", () => {
  assert.equal(service._test.classifyMarginSearch("MLB5329848148"), "mlb");
  assert.equal(service._test.classifyMarginSearch("125995-125189"), "sku_or_text");
  assert.equal(service._test.classifyMarginSearch("Poltrona bege"), "text");
});

test("targeted margin candidates replace the snapshot and reject another seller", () => {
  const snapshot = [{ item_id: "MLB1111111111", seller_id: 123, title: "Outro" }];
  const target = { item_id: "MLB5329848148", seller_id: 123, title: "Alvo" };
  assert.deepEqual(service._test.selectMarginCandidates({
    query: "MLB5329848148", sellerId: 123, snapshotItems: snapshot, targetedItems: [target],
  }).map((row) => row.item_id), ["MLB5329848148"]);
  assert.deepEqual(service._test.selectMarginCandidates({
    query: "MLB5329848148", sellerId: 123, snapshotItems: snapshot,
    targetedItems: [{ ...target, seller_id: 456 }],
  }), []);
});

test("direct MLB search respects the listing status filter", () => {
  const rows = service._test.selectMarginCandidates({
    query: "MLB5329848148", sellerId: 123, status: "active", snapshotItems: [],
    targetedItems: [{ item_id: "MLB5329848148", seller_id: 123, status: "paused" }],
  });
  assert.deepEqual(rows, []);
});

test("unfiltered seller inventory keeps rows whose detail omitted seller_id", () => {
  const rows = service._test.selectMarginCandidates({
    sellerId: 123, snapshotItems: [{ item_id: "MLB1111111111", status: "active" }],
  });
  assert.deepEqual(rows.map((row) => row.item_id), ["MLB1111111111"]);
});

test("SKU lookup includes every matching listing and not unrelated snapshot items", () => {
  const rows = service._test.selectMarginCandidates({
    query: "ABC-10", sellerId: 123,
    snapshotItems: [{ item_id: "MLB1111111111", seller_id: 123, title: "Outro" }],
    targetedItems: [
      { item_id: "MLB2222222222", seller_id: 123, reference_skus: ["ABC-10"] },
      { item_id: "MLB3333333333", seller_id: 123, variation_skus: [{ reference_sku: "ABC-10" }] },
    ],
  });
  assert.deepEqual(rows.map((row) => row.item_id), ["MLB2222222222", "MLB3333333333"]);
});

test("margin candidate resolution loads an MLB outside the snapshot", async () => {
  const calls = [];
  const candidates = await service._test.resolveMarginCandidates({
    query: { q: "MLB5329848148", status: "all" },
    snapshot: { seller: { id: 123 }, items: [{ item_id: "MLB1111111111", seller_id: 123 }] },
    context: { accountKey: "account" },
    targetedLookup: async (_context, lookupQuery, seller, options) => {
      calls.push({ lookupQuery, seller, options });
      return [{ item_id: "MLB5329848148", seller_id: 123 }];
    },
  });
  assert.deepEqual(candidates.map((item) => item.item_id), ["MLB5329848148"]);
  assert.equal(calls[0].lookupQuery.lookup_type, "mlb");
  assert.equal(calls[0].options.strict, true);
});

test("margin candidate resolution propagates direct lookup failures", async () => {
  await assert.rejects(service._test.resolveMarginCandidates({
    query: { q: "ABC-10", status: "all" },
    snapshot: { seller: { id: 123 }, items: [] },
    context: {},
    targetedLookup: async () => { throw new Error("ML unavailable"); },
  }), /ML unavailable/);
});

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

test("exact SKU excludes other variations of the same MLB from period revenue", async () => {
  const result = await service._test.buildOrderFinancials({
    state: {}, seller: { id: 123 }, range: {}, itemIds: ["MLB5329848148"],
    itemFilterActive: true, skuFilter: "ABC-10", limit: 10,
    itemsById: new Map([["MLB5329848148", {
      item_id: "MLB5329848148", status: "active", reference_sku: "",
      reference_skus: ["ABC-10", "XYZ-20"],
      variation_skus: [
        { variation_id: "1", reference_sku: "ABC-10" },
        { variation_id: "2", reference_sku: "XYZ-20" },
      ],
    }]]),
    costMap: new Map(), taxPct: 0, accountKey: null,
    ordersOverride: [{ id: 1, order_items: [
      { item: { id: "MLB5329848148", variation_id: "1", seller_sku: "ABC-10" }, quantity: 1, unit_price: 100 },
      { item: { id: "MLB5329848148", variation_id: "2", seller_sku: "XYZ-20" }, quantity: 1, unit_price: 200 },
    ] }],
    includeGrossAdjustments: false,
  });
  assert.equal(result.orders.length, 1);
  assert.deepEqual(result.orders[0].order_items.map((row) => row.sku), ["ABC-10"]);
  assert.equal(result.summary.period_revenue, 100);
});

test("cancelled revenue respects the same MLB and SKU scope", () => {
  const result = service._test.summarizeOrderRevenue([{ id: 10, order_items: [
    { item: { id: "MLB5329848148", variation_id: "1", seller_sku: "ABC-10" }, quantity: 1, unit_price: 100 },
    { item: { id: "MLB5329848148", variation_id: "2", seller_sku: "XYZ-20" }, quantity: 1, unit_price: 200 },
    { item: { id: "MLB9999999999" }, quantity: 1, unit_price: 300 },
  ] }], {
    itemIds: ["MLB5329848148"], itemFilterActive: true, skuFilter: "ABC-10",
    itemsById: new Map(),
  });
  assert.equal(result.revenue, 100);
  assert.equal(result.orders, 1);
  assert.equal(result.units, 1);
});

test("summary and period views keep the same selected MLB", async () => {
  const options = {
    state: {}, seller: { id: 123 }, range: {}, itemIds: ["MLB5329848148"],
    itemFilterActive: true, limit: 10, itemsById: new Map(), costMap: new Map(),
    taxPct: 0, accountKey: null, includeGrossAdjustments: false,
    ordersOverride: [{ id: 1, order_items: [
      { item: { id: "MLB5329848148" }, quantity: 1, unit_price: 100 },
      { item: { id: "MLB9999999999" }, quantity: 1, unit_price: 200 },
    ] }],
  };
  const paidFinancials = await service._test.buildOrderFinancials(options);
  const allOrderFinancials = await service._test.buildOrderFinancials(options);
  const scope = service._test.resolveMarginPeriodScope({ paidFinancials, allOrderFinancials });
  assert.equal(scope.summary.period_revenue, 100);
  assert.deepEqual(scope.summaryRows[0].order_items.map((row) => row.mlb), ["MLB5329848148"]);
  assert.deepEqual(scope.periodRows[0].order_items.map((row) => row.mlb), ["MLB5329848148"]);
});

test("equilibrium estimates show only the selected SKU variation", () => {
  const result = service._test.selectMarginPricingCandidates([{
    item_id: "MLB5329848148", price: 100, reference_sku: "",
    variation_skus: [
      { variation_id: "1", reference_sku: "ABC-10", price: 100 },
      { variation_id: "2", reference_sku: "XYZ-20", price: 200 },
    ],
  }], "ABC-10");
  assert.equal(result.exactSkuSearch, true);
  assert.deepEqual(result.rows.map((row) => row.variation_id), ["1"]);
});
