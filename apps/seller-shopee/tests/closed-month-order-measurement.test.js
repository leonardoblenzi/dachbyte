"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { previousClosedMonthWindow, countPaidOrders } = require("../src/services/closedMonthOrderMeasurement");

test("closed month uses inclusive UTC start and exclusive UTC end", () => {
  assert.deepEqual(previousClosedMonthWindow(new Date("2026-10-21T12:00:00Z")), {
    periodStart: "2026-09-01T00:00:00.000Z",
    periodEndExclusive: "2026-10-01T00:00:00.000Z",
  });
});

test("counts only paid non-cancelled orders after complete pagination", async () => {
  const seen = [];
  const total = await countPaidOrders({ shopId: "123", window: {
    periodStart: "2026-09-01T00:00:00.000Z", periodEndExclusive: "2026-10-01T00:00:00.000Z",
  }, getList: async (args) => {
    seen.push(args);
    return { response: { order_list: !args.cursor ? [{ order_sn: "A" }, { order_sn: "B" }] : [{ order_sn: "C" }], more: !args.cursor, next_cursor: !args.cursor ? "next" : "" } };
  }, getDetail: async ({ orderSnList }) => ({ response: { order_list: orderSnList.map((sn) => ({
    order_sn: sn, pay_time: sn === "B" ? 0 : 1, order_status: sn === "C" ? "CANCELLED" : "COMPLETED",
  })) } }) });
  assert.equal(total, 1);
  assert.ok(seen.length >= 4); // 14-day windows, with page 2 in the first window.
  assert.ok(seen.every((entry) => entry.timeRangeField === "create_time"));
});

test("incomplete list or details never becomes zero", async () => {
  const window = { periodStart: "2026-09-01T00:00:00.000Z", periodEndExclusive: "2026-10-01T00:00:00.000Z" };
  await assert.rejects(countPaidOrders({ shopId: "123", window,
    getList: async () => ({ response: { order_list: [], more: true } }),
    getDetail: async () => ({ response: { order_list: [] } }),
  }), /pagination/);
  await assert.rejects(countPaidOrders({ shopId: "123", window,
    getList: async () => ({ response: { order_list: [{ order_sn: "A" }], more: true, next_cursor: "same" } }),
    getDetail: async () => ({ response: { order_list: [{ order_sn: "A", pay_time: 1, order_status: "COMPLETED" }] } }),
  }), /pagination/);
  await assert.rejects(countPaidOrders({ shopId: "123", window,
    getList: async () => ({ response: { order_list: [{ order_sn: "A" }], more: false } }),
    getDetail: async () => ({ response: { order_list: [] } }),
  }), /details/);
});

test("complete empty Shopee response is a measured zero", async () => {
  const total = await countPaidOrders({ shopId: "123", window: {
    periodStart: "2026-09-01T00:00:00.000Z", periodEndExclusive: "2026-10-01T00:00:00.000Z",
  }, getList: async () => ({ response: { order_list: [], more: false } }),
  getDetail: async () => { throw new Error("should not fetch details"); } });
  assert.equal(total, 0);
});
