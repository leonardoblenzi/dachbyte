"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function read(relative) {
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
}

const appSource = read("public/app.js");
const profitSource = read("public/profit-financial.js");
const pricingSource = read("public/pricing-engine.js");
const marketSource = read("public/market-financial.js");

test("decision pages use the shared prototype presentation contracts", () => {
  assert.match(appSource, /key==="products"[\s\S]*class="pagehead"/);
  assert.match(appSource, /key==="products"[\s\S]*class="card section"/);
  assert.match(profitSource, /class="card section"/);
  assert.match(pricingSource, /class="price-sim"|class="matrix"/);
  assert.match(marketSource, /class="chip/);
});

test("decision pages retain their real data routes", () => {
  assert.match(appSource, /async function modulePage[\s\S]*api\(`\/\$\{key\}`\)/);
  for (const route of ["/products", "/pricing/simulate"]) {
    assert.ok(appSource.includes(route), `missing module route: ${route}`);
  }
  for (const route of ["/profit", "/profit/order/"]) {
    assert.ok(profitSource.includes(route), `missing Profit route: ${route}`);
  }
  for (const route of ["/pricing", "/pricing/run", "/pricing/samples", "/pricing/policies", "/review"]) {
    assert.ok(pricingSource.includes(route), `missing Pricing route: ${route}`);
  }
  for (const route of ["/market", "/market/sources", "/market/import", "/market/matches/", "/market/signals/"]) {
    assert.ok(marketSource.includes(route), `missing Market route: ${route}`);
  }
});

test("pricing remains review-only and never publishes a price automatically", () => {
  assert.doesNotMatch(pricingSource, /fetch\([^)]*(publish|auto-apply|automatic)/i);
  assert.doesNotMatch(pricingSource, /api\([^)]*(publish|auto-apply|automatic)/i);
  assert.match(pricingSource, /Aprovar n[^<]*o altera pre[^<]*o/);
});

test("Profit labels only realized snapshot fees as real", () => {
  assert.match(appSource, /realizedSnapshots=snapshots\.filter\(x=>x\.calculation_type==="realized"\)/);
  assert.match(appSource, /realizedFees=realizedSnapshots\.reduce\(\(sum,x\)=>sum\+Number\(x\.fees_amount\|\|0\),0\)/);
  assert.match(appSource, /Taxas reais<\/small><strong>\$\{realizedSnapshots\.length\?money\(realizedFees\):"—"\}/);
  assert.doesNotMatch(appSource, /Taxas reais<\/small><strong>\$\{hasSnapshots\?money\(data\.totals\?\.fees_amount\)/);
});
