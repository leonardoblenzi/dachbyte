"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  previousClosedMonthWindow,
  fetchPaidOrdersTotal,
  rangeForPaidOrders,
} = require("../services/closedMonthOrderMeasurement");

test("last closed month uses UTC boundary and an hourly-safe ML search end", () => {
  const window = previousClosedMonthWindow(new Date("2026-10-20T12:00:00.000Z"));
  assert.deepEqual(window, {
    periodStart: "2026-09-01T00:00:00.000Z",
    periodEndExclusive: "2026-10-01T00:00:00.000Z",
    searchEndInclusive: "2026-09-30T23:00:00.000Z",
  });
});

test("paid order count uses the ML paging total and never scans the full account", async () => {
  let requested;
  const total = await fetchPaidOrdersTotal({
    accessToken: "token", sellerId: 123,
    window: previousClosedMonthWindow(new Date("2026-10-20T12:00:00.000Z")),
    fetchImpl: async (url, init) => {
      requested = { url: new URL(url), init };
      return { ok: true, json: async () => ({ paging: { total: 1001 } }) };
    }
  });
  assert.equal(total, 1001);
  assert.equal(requested.url.searchParams.get("order.status"), "paid");
  assert.equal(requested.url.searchParams.get("order.date_created.to"), "2026-09-30T23:00:00.000Z");
  assert.equal(requested.url.searchParams.get("limit"), "1");
  assert.equal(requested.init.headers.authorization, "Bearer token");
});

test("missing paging total, invalid response or API failure cannot become zero sales", async () => {
  const base = {
    accessToken: "token", sellerId: 123,
    window: previousClosedMonthWindow(new Date("2026-10-20T12:00:00.000Z")),
  };
  await assert.rejects(fetchPaidOrdersTotal({ ...base,
    fetchImpl: async () => ({ ok: true, json: async () => ({ results: [] }) })
  }), /ml_orders_total_unavailable/);
  await assert.rejects(fetchPaidOrdersTotal({ ...base,
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) })
  }), /ml_orders_search_429/);
});

test("closed-month ranges follow the approved fixed tiers and route >3000 to sales", () => {
  assert.equal(rangeForPaidOrders(0), "up_to_30");
  assert.equal(rangeForPaidOrders(1500), "from_701_to_1500");
  assert.equal(rangeForPaidOrders(1501), "from_1501_to_3000");
  assert.equal(rangeForPaidOrders(3000), "from_1501_to_3000");
  assert.equal(rangeForPaidOrders(3001), "contact_sales");
  assert.throws(() => rangeForPaidOrders(NaN), /ml_orders_total_invalid/);
});
