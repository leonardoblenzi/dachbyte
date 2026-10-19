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

test("single search term unites exact SKU, exact EAN and product-title matches", () => {
  const snapshotItems = [
    { item_id: "MLB1111111111", seller_id: 123, reference_sku: "ABC-10", title: "Mesa" },
    { item_id: "MLB2222222222", seller_id: 123, eans: ["7891234567890"], title: "Sofá" },
    { item_id: "MLB3333333333", seller_id: 123, title: "Mesa ABC-10" },
    { item_id: "MLB4444444444", seller_id: 456, title: "Mesa ABC-10" },
    { item_id: "MLB5555555555", seller_id: 123, title: "Código 7891234567890 sem EAN" },
  ];
  assert.deepEqual(service._test.selectMarginCandidates({
    query: "ABC-10", sellerId: 123, snapshotItems,
  }).map((item) => item.item_id), ["MLB1111111111", "MLB3333333333"]);
  assert.deepEqual(service._test.selectMarginCandidates({
    query: "7891234567890", sellerId: 123, snapshotItems,
  }).map((item) => item.item_id), ["MLB2222222222"]);
  assert.deepEqual(service._test.selectMarginCandidates({
    query: "789123456789", sellerId: 123, snapshotItems,
  }), []);
});

test("EAN lookup scopes catalog matches by account and seller", async () => {
  let captured;
  const rows = await service._test.lookupMarginEanMatches("drossi", 123, "7891234567890", async (sql, values) => {
    captured = { sql, values };
    return { rows: [{ mlb: "MLB1111111111", variation_id: "2" }] };
  });
  assert.deepEqual(captured.values, ["drossi", "123", "7891234567890"]);
  assert.match(captured.sql, /account_key\s*=\s*\$1/);
  assert.match(captured.sql, /seller_id\s*=\s*\$2/);
  assert.match(captured.sql, /eans\s*\?\s*\$3/);
  assert.deepEqual(rows, [{ mlb: "MLB1111111111", variation_id: "2" }]);
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

test("exact MLB keeps sold orders in scope when listing lookup has no candidate", async () => {
  const itemIds = service._test.resolveMarginOrderItemIds("MLB6827582394", []);
  const result = await service._test.buildOrderFinancials({
    state: {}, seller: { id: 123 }, range: {}, itemIds,
    itemFilterActive: true, limit: 10, itemsById: new Map(), costMap: new Map(),
    taxPct: 0, accountKey: null, includeGrossAdjustments: false,
    ordersOverride: [{ id: 1, order_items: [
      { item: { id: "MLB6827582394", seller_sku: "111915-110193" }, quantity: 1, unit_price: 517.73 },
      { item: { id: "MLB9999999999" }, quantity: 1, unit_price: 200 },
    ] }],
  });
  assert.equal(result.orders.length, 1);
  assert.deepEqual(result.orders[0].order_items.map((row) => row.mlb), ["MLB6827582394"]);
});

test("historical SKU and product title match order items without listing candidates", async () => {
  const ordersOverride = [{ id: 1, order_items: [
    { item: { id: "MLB1111111111", title: "Painel Luana Fendi", seller_sku: "ABC-10" }, quantity: 1, unit_price: 100 },
    { item: { id: "MLB2222222222", title: "Mesa Retrô", seller_sku: "XYZ-20" }, quantity: 1, unit_price: 200 },
  ] }];
  const base = {
    state: {}, seller: { id: 123 }, range: {}, itemIds: [], itemFilterActive: true,
    limit: 10, itemsById: new Map(), costMap: new Map(), taxPct: 0,
    accountKey: null, includeGrossAdjustments: false, ordersOverride,
  };
  const bySku = await service._test.buildOrderFinancials({ ...base, searchTerm: "ABC-10" });
  assert.deepEqual(bySku.orders[0].order_items.map((row) => row.mlb), ["MLB1111111111"]);
  const byName = await service._test.buildOrderFinancials({ ...base, searchTerm: "luana" });
  assert.deepEqual(byName.orders[0].order_items.map((row) => row.mlb), ["MLB1111111111"]);
  const missing = await service._test.buildOrderFinancials({ ...base, searchTerm: "inexistente" });
  assert.deepEqual(missing.orders, []);
  const statusScoped = await service._test.buildOrderFinancials({
    ...base, searchTerm: "luana", status: "active",
  });
  assert.deepEqual(statusScoped.orders, []);
});

test("EAN catalog match limits orders to the identified variation", async () => {
  const result = await service._test.buildOrderFinancials({
    state: {}, seller: { id: 123 }, range: {}, itemIds: [], itemFilterActive: true,
    searchTerm: "7891234567890",
    eanMatches: [{ mlb: "MLB1111111111", variation_id: "1" }],
    limit: 10, itemsById: new Map(), costMap: new Map(), taxPct: 0,
    accountKey: null, includeGrossAdjustments: false,
    ordersOverride: [{ id: 1, order_items: [
      { item: { id: "MLB1111111111", variation_id: "1" }, quantity: 1, unit_price: 100 },
      { item: { id: "MLB1111111111", variation_id: "2" }, quantity: 1, unit_price: 200 },
    ] }],
  });
  assert.deepEqual(result.orders[0].order_items.map((row) => row.variation_id), ["1"]);
  assert.equal(result.summary.period_revenue, 100);
});

test("historical EAN without a catalog or listing link does not infer another product", async () => {
  const result = await service._test.buildOrderFinancials({
    state: {}, seller: { id: 123 }, range: {}, itemIds: [], itemFilterActive: true,
    searchTerm: "7891234567890", eanMatches: [], limit: 10,
    itemsById: new Map(), costMap: new Map(), taxPct: 0,
    accountKey: null, includeGrossAdjustments: false,
    ordersOverride: [{ id: 1, order_items: [
      { item: { id: "MLB1111111111", seller_sku: "ABC-10" }, quantity: 1, unit_price: 100 },
    ] }],
  });
  assert.deepEqual(result.orders, []);
});

test("EAN from listing detail selects only its matching variation", async () => {
  const detail = {
    item_id: "MLB1111111111", eans: ["7891234567890"], item_eans: [],
    variation_eans: [{ variation_id: "1", eans: ["7891234567890"] }],
  };
  const result = await service._test.buildOrderFinancials({
    state: {}, seller: { id: 123 }, range: {}, itemIds: [detail.item_id],
    itemFilterActive: true, searchTerm: "7891234567890", limit: 10,
    itemsById: new Map([[detail.item_id, detail]]), costMap: new Map(),
    taxPct: 0, accountKey: null, includeGrossAdjustments: false,
    ordersOverride: [{ id: 1, order_items: [
      { item: { id: detail.item_id, variation_id: "1" }, quantity: 1, unit_price: 100 },
      { item: { id: detail.item_id, variation_id: "2" }, quantity: 1, unit_price: 200 },
    ] }],
  });
  assert.deepEqual(result.orders[0].order_items.map((row) => row.variation_id), ["1"]);
});

test("SKU and product-title union keeps both pricing rows", () => {
  const result = service._test.selectMarginPricingCandidates([
    { item_id: "MLB1111111111", reference_sku: "ABC-10", title: "Mesa" },
    { item_id: "MLB2222222222", reference_sku: "XYZ-20", title: "Mesa ABC-10" },
  ], "ABC-10");
  assert.deepEqual(result.rows.map((row) => row.item_id), ["MLB1111111111", "MLB2222222222"]);
});

test("EAN pricing keeps only the matching variation", () => {
  const result = service._test.selectMarginPricingCandidates([{
    item_id: "MLB1111111111", reference_sku: "", title: "Sofá", eans: ["7891234567890"],
    item_eans: [],
    variation_skus: [
      { variation_id: "1", reference_sku: "SOFA-A" },
      { variation_id: "2", reference_sku: "SOFA-B" },
    ],
    variation_eans: [{ variation_id: "1", eans: ["7891234567890"] }],
  }], "7891234567890");
  assert.deepEqual(result.rows.map((row) => row.variation_id), ["1"]);
});

test("EAN pricing keeps the matching variation when the listing also has a common SKU", () => {
  const result = service._test.selectMarginPricingCandidates([{
    item_id: "MLB1111111111", reference_sku: "SOFA", title: "Sofá",
    eans: ["7891234567890"], item_eans: [],
    variation_skus: [
      { variation_id: "1", reference_sku: "SOFA-A", price: 100 },
      { variation_id: "2", reference_sku: "SOFA-B", price: 200 },
    ],
    variation_eans: [{ variation_id: "2", eans: ["7891234567890"] }],
  }], "7891234567890");
  assert.deepEqual(result.rows.map((row) => row.variation_id), ["2"]);
});

test("margin XLSX reuses the same identifier search", async () => {
  const original = service.listMargin;
  let forwarded;
  try {
    service.listMargin = async (query) => {
      forwarded = query;
      return { filters: { date_from: "2026-10-13", date_to: "2026-10-19" }, period_rows: [] };
    };
    const file = await service.exportMargin({ view: "period", q: "MLB6827582394" }, {});
    assert.equal(forwarded.q, "MLB6827582394");
    assert.equal(file.contentType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  } finally {
    service.listMargin = original;
  }
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
