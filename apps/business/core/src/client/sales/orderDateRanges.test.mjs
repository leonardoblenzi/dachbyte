import test from "node:test";
import assert from "node:assert/strict";
import { identifyOrderPeriod, orderPeriodRange, shiftOrderDateKey } from "./orderDateRanges.mjs";

test("preset ranges include today and cross month boundaries safely", () => {
  assert.deepEqual(orderPeriodRange("last7", "2026-10-11"), { start: "2026-10-05", end: "2026-10-11" });
  assert.deepEqual(orderPeriodRange("last15", "2026-10-11"), { start: "2026-09-27", end: "2026-10-11" });
  assert.deepEqual(orderPeriodRange("last30", "2026-01-05"), { start: "2025-12-07", end: "2026-01-05" });
  assert.deepEqual(orderPeriodRange("yesterday", "2026-01-01"), { start: "2025-12-31", end: "2025-12-31" });
  assert.equal(shiftOrderDateKey("2026-03-01", -1), "2026-02-28");
});

test("existing navigation ranges retain their custom or preset meaning", () => {
  assert.equal(identifyOrderPeriod({ start: "2026-10-05", end: "2026-10-11" }, "2026-10-11"), "last7");
  assert.equal(identifyOrderPeriod({ start: "2026-10-01", end: "2026-10-08" }, "2026-10-11"), "custom");
  assert.equal(identifyOrderPeriod({ start: "", end: "" }, "2026-10-11"), "all");
});
