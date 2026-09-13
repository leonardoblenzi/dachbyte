"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../src/services/AdsRoasMetricsService");

test("prioriza o desempenho diario oficial completo sobre o snapshot parcial", async () => {
  const result = await _test.collectRoasMetricsForRangeWithDependencies({
    shop: { shopId: "123" },
    shopDbId: 7,
    start: new Date("2026-08-01T00:00:00.000Z"),
    end: new Date("2026-08-24T23:59:59.999Z"),
    dateFrom: "2026-08-01",
    dateTo: "2026-08-24",
    dependencies: {
      aggregateAdsMetricsByShopAndRange: async () => ({ _sum: { expense: 1500, broadGmv: 30000, directGmv: 25000, broadSold: 3, directSold: 2 } }),
      aggregateAttributedOrdersByShopAndRange: async () => ({ _sum: { gmvCents: 20000 }, _count: { id: 2 } }),
      aggregateAttributedOrderItemsByShopAndRange: async () => ({ _sum: { quantity: 2 } }),
      sumStorePaidRevenueCents: async () => 200000,
      fetchOfficialDailyAdsTotals: async () => ({
        available: true,
        expenseCents: 10000,
        broadGmvCents: 50000,
        directGmvCents: 40000,
        broadOrders: 5,
        directOrders: 4,
        broadItemsSold: 6,
        directItemsSold: 5,
      }),
    },
  });

  assert.equal(result.sourceAdsTotals, "official_daily_performance");
  assert.equal(result.metrics.spendCents, 10000);
  assert.equal(result.metrics.storeGmvCents, 200000);
  assert.equal(result.metrics.tacosPct, 5);
  assert.equal(result.metrics.roas, 5);
  assert.equal(result.counts.ordersMatched, 5);
});

test("divide meses de 31 dias sem perder o ultimo dia", async () => {
  const calls = [];
  const result = await _test.fetchOfficialDailyAdsTotalsWithDependencies({
    shop: { shopId: "123" },
    dateFrom: "2026-07-01",
    dateTo: "2026-07-31",
    dependencies: {
      callAdsWithAutoRefresh: async ({ call }) => call("token"),
      getDailyPerformance: async ({ startDate, endDate }) => {
        calls.push({ startDate, endDate });
        return { response: [{ expense: "1.00", broad_gmv: "5.00", broad_order: 1 }] };
      },
    },
  });

  assert.deepEqual(calls, [
    { startDate: "01-07-2026", endDate: "30-07-2026" },
    { startDate: "31-07-2026", endDate: "31-07-2026" },
  ]);
  assert.equal(result.available, true);
  assert.equal(result.rows, 2);
  assert.equal(result.expenseCents, 200);
  assert.equal(result.broadGmvCents, 1000);
  assert.equal(result.broadOrders, 2);
});

test("mantem o snapshot do banco quando a consulta oficial de Ads nao esta disponivel", async () => {
  const result = await _test.collectRoasMetricsForRangeWithDependencies({
    shop: { shopId: "123" },
    shopDbId: 7,
    start: new Date("2026-08-01T00:00:00.000Z"),
    end: new Date("2026-08-24T23:59:59.999Z"),
    dateFrom: "2026-08-01",
    dateTo: "2026-08-24",
    dependencies: {
      aggregateAdsMetricsByShopAndRange: async () => ({ _sum: { expense: 1500, broadGmv: 30000, directGmv: 0, broadSold: 3 } }),
      aggregateAttributedOrdersByShopAndRange: async () => ({ _sum: { gmvCents: 20000 }, _count: { id: 2 } }),
      aggregateAttributedOrderItemsByShopAndRange: async () => ({ _sum: { quantity: 2 } }),
      sumStorePaidRevenueCents: async () => 50000,
      fetchOfficialDailyAdsTotals: async () => ({ available: false }),
    },
  });

  assert.equal(result.sourceAdsTotals, "database_snapshot");
  assert.equal(result.metrics.spendCents, 1500);
  assert.equal(result.metrics.tacosPct, 3);
});

test("nao deixa uma resposta oficial vazia apagar os dados locais de Ads", async () => {
  const result = await _test.collectRoasMetricsForRangeWithDependencies({
    shop: { shopId: "123" },
    shopDbId: 7,
    start: new Date("2026-08-01T00:00:00.000Z"),
    end: new Date("2026-08-24T23:59:59.999Z"),
    dateFrom: "2026-08-01",
    dateTo: "2026-08-24",
    dependencies: {
      aggregateAdsMetricsByShopAndRange: async () => ({ _sum: { expense: 8750, broadGmv: 42000, directGmv: 0, broadSold: 9, directSold: 0 } }),
      sumStorePaidRevenueCents: async () => 350000,
      fetchOfficialDailyAdsTotals: async () => ({ available: true, expenseCents: 0, broadGmvCents: 0, directGmvCents: 0, broadOrders: 0, directOrders: 0 }),
    },
  });

  assert.equal(result.sourceAdsTotals, "database_snapshot");
  assert.equal(result.metrics.spendCents, 8750);
  assert.equal(result.metrics.attributedGmvCents, 42000);
  assert.equal(result.counts.ordersMatched, 9);
  assert.equal(result.metrics.tacosPct, 2.5);
});
