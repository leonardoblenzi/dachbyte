"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../src/repositories/uxAnalyticsRepository");

test("margin SQL prefers order items and falls back to account-owned delivery items", () => {
  const sql = _test.marginOrderCte();
  assert.match(sql, /from magalu\.delivery_items di/i);
  assert.match(sql, /not exists\s*\(select 1 from order_quality q/i);
  assert.match(sql, /order_quality as \(/i);
  assert.match(sql, /di\.account_id=d\.account_id/i);
});

test("delivery fallback requires a complete manifest, SKU, quantity and price", () => {
  const sql = _test.marginOrderCte();
  assert.match(sql, /dc\.expected_items\s*=\s*dc\.actual_items/i);
  assert.match(sql, /dc\.expected_items>0/i);
  assert.match(sql, /\(o\.item_count=0 or o\.item_count=dc\.actual_items\)/i);
  assert.match(sql, /di\.sku is null/i);
  assert.match(sql, /di\.quantity\s*<=\s*0/i);
  assert.match(sql, /di\.amount_total is null and di\.unit_price is null/i);
});

test("the same remote item repeated across deliveries cannot complete CMV", () => {
  const sql = _test.marginOrderCte();
  assert.match(sql, /duplicate_delivery_items as/i);
  assert.match(sql, /coalesce\(nullif\(di\.remote_item_id,''\),di\.item_key\)/i);
  assert.match(sql, /coalesce\(dup\.duplicates,0\)=0/i);
});
