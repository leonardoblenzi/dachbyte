"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assertAvailableStockWithClient,
  stockTotalsWithClient,
} = require("./runtime/services/stockReservationService");

test("stock reservation totals keep physical, reserved and available quantities separate", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ physical: "10.000", reserved: "3.000" }] };
    },
  };

  const totals = await stockTotalsWithClient(client, "cmp-1", "prd-1");

  assert.deepEqual(totals, { physical: 10, reserved: 3, available: 7 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ["cmp-1", "prd-1"]);
  assert.match(calls[0].sql, /inventory_movements/);
  assert.match(calls[0].sql, /stock_reservations/);
  assert.match(calls[0].sql, /status='active'/);
});

test("stock availability blocks a sale that would consume units reserved by another order", async () => {
  const client = {
    async query() {
      return { rows: [{ physical: "5", reserved: "4" }] };
    },
  };

  await assert.rejects(
    () => assertAvailableStockWithClient(client, "cmp-1", "prd-1", 2),
    (error) => {
      assert.equal(error.code, "INSUFFICIENT_AVAILABLE_STOCK");
      assert.equal(error.statusCode, 409);
      assert.deepEqual(error.details, {
        productId: "prd-1",
        requested: 2,
        physical: 5,
        reserved: 4,
        available: 1,
      });
      return true;
    },
  );

  await assert.doesNotReject(
    () => assertAvailableStockWithClient(client, "cmp-1", "prd-1", 1),
  );
});
