"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../src/repositories/uxAnalyticsRepository.js"), "utf8");

test("period margin requires both registered costs and a financial snapshot", () => {
  assert.match(source, /left join magalu\.order_financial_reports fr on fr\.account_id=o\.account_id and fr\.order_code=o\.code/);
  assert.match(source, /missing_cost_items=0 and financial_report_present/);
  assert.match(source, /net_receivable-product_cost-taxes-operating_costs/);
  assert.match(source, /\/units else null end as break_even_per_unit/);
  assert.match(source, /\/units else null end as headroom_per_unit/);
  assert.match(source, /as tax_base/);
});

test("unknown financial data never becomes a zero-valued reconciled result", () => {
  assert.match(source, /\(fr\.order_code is not null and fr\.transaction_count>0\) as financial_report_present/);
  assert.match(source, /case when missing_cost_items=0 and financial_report_present then/);
});

test("paged margin identities and missing costs are loaded in account-scoped batches", () => {
  assert.match(source, /enrichMarginRows\(rows,items\.rows,deliveries\.rows\)/);
  assert.match(source, /oi\.account_id=\$1 and oi\.order_id=any\(\$2::bigint\[\]\)/);
  assert.match(source, /d\.account_id=\$1 and d\.order_id=any\(\$2::bigint\[\]\)/);
  assert.match(source, /coalesce\(s\.is_present,false\) as catalog_present/);
});
