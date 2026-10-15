"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../src/services/orderSyncService");

test("period order sync keeps only selected days and stops on an older sorted page", () => {
  const rows = [
    { purchased_at: "2026-10-15T15:00:00Z" },
    { purchased_at: "2026-10-14T15:00:00Z" },
    { purchased_at: "2026-10-08T15:00:00Z" },
    { purchased_at: "2026-10-07T23:00:00Z" },
  ];
  const selection = _test.selectMarginOrderPage(rows, "2026-10-08", "2026-10-14");
  assert.equal(selection.rows.length, 2);
  assert.deepEqual(selection.rows.map(row => row.purchased_at.slice(0, 10)), ["2026-10-14", "2026-10-08"]);
  assert.equal(selection.reachedStart, true);
});

test("period order sync does not stop at a page entirely newer than selected interval", () => {
  const selection = _test.selectMarginOrderPage([{ purchased_at: "2026-10-15T15:00:00Z" }], "2026-10-08", "2026-10-14");
  assert.deepEqual(selection.rows, []);
  assert.equal(selection.reachedStart, false);
});

test("period sync rejects an incomplete pagination boundary", () => {
  const source = require("node:fs").readFileSync(require("node:path").resolve(__dirname, "../src/services/orderSyncService.js"), "utf8");
  assert.match(source, /MAGALU_MARGIN_ORDERS_PAGE_LIMIT/);
  assert.match(source, /MAGALU_MARGIN_DELIVERIES_PAGE_LIMIT/);
});
