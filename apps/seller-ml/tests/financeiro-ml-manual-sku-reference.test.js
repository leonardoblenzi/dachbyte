"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const FinanceiroMlService = require("../services/financeiroMlService");
const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("recognizes the raw SKU returned on Mercado Livre variations", () => {
  const skus = FinanceiroMlService._test.extractReferenceSkuValues({
    variations: [{ id: 1, sku: " var-azul-42 " }],
  });
  assert.deepEqual(skus, ["VAR-AZUL-42"]);
});

test("uses a single Mercado Livre seller_sku search match only when item details omit SKU", () => {
  const items = [
    { item_id: "MLB5352019964", reference_sku: "", reference_skus: [] },
    { item_id: "MLB100", reference_sku: "ORIGINAL", reference_skus: ["ORIGINAL"] },
    { item_id: "MLB200", reference_sku: "", reference_skus: [] },
  ];
  const matches = new Map([
    ["MLB5352019964", new Set(["104402"])],
    ["MLB100", new Set(["SEARCHED"])],
    ["MLB200", new Set(["A", "B"])],
  ]);
  const result = FinanceiroMlService._test.applySkuSearchMatches(items, matches);
  assert.equal(result[0].reference_sku, "104402");
  assert.equal(result[0].sku_lookup_inferred, true);
  assert.equal(result[1].reference_sku, "ORIGINAL");
  assert.equal(result[2].reference_sku, "");
});

test("persists a manual MLB-to-SKU reference instead of treating the MLB as a cost SKU", () => {
  const migration = read("db/074_create_mercadolivre_sku_reference_overrides.sql");
  const service = read("services/financeiroMlService.js");
  const route = read("routes/financeiroMlRoutes.js");

  assert.match(migration, /mercadolivre_sku_reference_overrides/);
  assert.match(migration, /UNIQUE \(account_key, mlb, variation_id\)/);
  assert.match(service, /async function saveManualSkuReference/);
  assert.match(service, /source: "manual_reference"/);
  assert.match(route, /router\.post\("\/costs\/reference"/);
  assert.ok(
    route.indexOf('router.post("/costs/reference"') < route.indexOf('router.post("/costs/:sku"'),
    "the explicit reference endpoint must be registered before the SKU route",
  );
});

test("offers a manual reference and cost action only for rows without a reference SKU", () => {
  const costsJs = read("public/js/financeiro-ml-custos.js");
  assert.match(costsJs, /fml-reference-sku-input/);
  assert.match(costsJs, /fml-save-manual-reference/);
  assert.match(costsJs, /\/api\/financeiro-ml\/costs\/reference/);
  assert.match(costsJs, /O MLB não informou SKU/);
});
